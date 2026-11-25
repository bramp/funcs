/**
 * Copyright 2018 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import axios from 'axios';
import crypto from 'crypto';
import https from 'https';
import Route from 'route-parser';
import xml from 'xml';

const GA_MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID;
const GA_API_SECRET = process.env.GA_API_SECRET;
const VANGUARD_BASE_URL = process.env.VANGUARD_BASE_URL || 'https://api.vanguard.com/';
const LOG_UPSTREAM_REQUESTS = process.env.LOG_UPSTREAM_REQUESTS === '1';
const LOG_REQUEST_LIFECYCLE = process.env.LOG_REQUEST_LIFECYCLE === '1';

function memoryUsageMiB() {
    const memory = process.memoryUsage();
    return {
        rss: Number((memory.rss / (1024 * 1024)).toFixed(2)),
        heapUsed: Number((memory.heapUsed / (1024 * 1024)).toFixed(2)),
    };
}

function getTraceId(req) {
    const rawTraceHeader = req.get?.('x-cloud-trace-context');
    const traceHeader = (typeof rawTraceHeader === 'string') ? rawTraceHeader : '';
    return traceHeader.split('/')[0] || crypto.randomUUID();
}

function logEvent(level, message, fields = {}) {
    console.log(JSON.stringify({
        severity: level,
        message,
        ...fields,
    }));
}

function upstreamResponseFields(response, request = response?.request) {
    return {
        remoteAddress: request?.socket?.remoteAddress || null,
        reusedSocket: request?.reusedSocket ?? null,
        contentType: response?.headers?.['content-type'] || null,
        contentLength: response?.headers?.['content-length'] || null,
        server: response?.headers?.server || null,
    };
}

// TODO(bramp): The 404 retry, KNOWN_FUNDS and canary check below are a
// temporary workaround for Vanguard returning false 404s. Once the logs give
// us a heuristic that tells a false 404 from a real one (e.g. by
// responseBodySha256, or whether a fresh connection fixes it), remove
// KNOWN_FUNDS, CANARY_FUND, fetchWithRetry and classifyUpstream404 and replace
// them with that simpler check. See "Plan: replace this with a false-404
// heuristic" in README.md.

// Funds that always exist. An upstream 404 for any of these means Vanguard is
// misbehaving (not that the fund is missing), so we return a 500 instead.
export const KNOWN_FUNDS = new Set(['VMFXX', '7553', 'M219', '7555']);
const CANARY_FUND = '7555';

function isUpstream404(err) {
    return err?.response?.status === 404;
}

/**
 * Fetches from Vanguard, retrying a 404 once over a fresh (non keep-alive)
 * connection. Production 404s are sticky per instance, so the retry outcome is
 * logged to tell connection-level problems apart from instance-level ones.
 */
async function fetchWithRetry(name, path, requestLogFields) {
    try {
        return await fetchWithLog(name, path, requestLogFields);
    } catch (err) {
        if (!isUpstream404(err)) throw err;
        return fetchWithLog(name, path, { ...requestLogFields, retry: true }, {
            httpsAgent: new https.Agent({ keepAlive: false }),
        });
    }
}

async function fetchWithLog(name, path, requestLogFields, config) {
    const start = Date.now();
    const upstreamUrl = new URL(path, instance.defaults.baseURL).toString();
    try {
        const response = await instance.get(path, config);
        if (requestLogFields.retry || requestLogFields.canary) {
            logEvent('WARNING', `upstream ${name} ${requestLogFields.canary ? 'canary' : 'retry'} succeeded ${response.status}`, {
                ...requestLogFields,
                upstream: name,
                upstreamUrl,
                status: response.status,
                ...upstreamResponseFields(response),
            });
        }
        else if (LOG_UPSTREAM_REQUESTS) {
            const durationMs = Date.now() - start;
            const contentLength = response.headers?.['content-length'] || null;
            logEvent('INFO', `upstream ${name} ${response.status} ${durationMs}ms${contentLength ? ` ${contentLength}b` : ''}`, {
                ...requestLogFields,
                upstream: name,
                upstreamUrl,
                durationMs,
                status: response.status,
                ...upstreamResponseFields(response),
            });
        }
        return response.data;
    } catch (err) {
        // Axios throws on non-2xx responses and network failures; log and rethrow.
        const durationMs = Date.now() - start;
        const upstreamStatus = err.response?.status || null;
        logEvent('ERROR', `upstream ${name} failed${upstreamStatus ? ` ${upstreamStatus}` : ''} ${durationMs}ms: ${err.message}`, {
            ...requestLogFields,
            upstream: name,
            upstreamUrl,
            durationMs,
            status: upstreamStatus,
            error: err.message,
            code: err.code || null,
            ...upstreamResponseFields(err.response, err.response?.request || err.request),
            // Fingerprint error pages without logging response bodies or cookies.
            responseBodySha256: (typeof err.response?.data === 'string' || Buffer.isBuffer(err.response?.data))
                ? crypto.createHash('sha256').update(err.response.data).digest('hex')
                : null,
        });
        throw err;
    }
}

export const instance = axios.create({
    baseURL: VANGUARD_BASE_URL,
    timeout: 20000,
    headers: { 'Referer': 'https://investor.vanguard.com/' },
    httpsAgent: new https.Agent({ keepAlive: true }),
});

const gaInstance = axios.create({
    baseURL: 'https://www.google-analytics.com/',
    timeout: 5000,
    httpsAgent: new https.Agent({ keepAlive: true }),
});

const routes = [
    new Route('/vanguard/:fund'),  // cloudfunctions.net path (includes function name)
    new Route('/:fund'),            // run.app path (no function name prefix)
];

/**
 * Error for when there are illegal arguments passed to a function.
 */
class IllegalArgumentError extends Error { }

/**
 * Error for when Vanguard misbehaves; always reported as a 500.
 */
class UpstreamError extends Error { }

/**
 * Error carrying an explicit HTTP status for client-facing validation failures.
 */
class HttpStatusError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export function normalizeAndValidateFundId(rawFund) {
    const fundId = String(rawFund || '').trim().toUpperCase();

    // Accept known Vanguard identifier families:
    // - 4-digit internal IDs (e.g. 7555, 0584, 1865)
    // - letter + 3 digits (e.g. M219, N488)
    // - 5-letter share class tickers (e.g. VMFXX, VTSAX, PIMIX)
    const isValid = /^\d{4}$/.test(fundId) || /^[A-Z]\d{3}$/.test(fundId) || /^[A-Z]{5}$/.test(fundId);
    if (!isValid) {
        throw new HttpStatusError(
            400,
            'Invalid fund id format. Expected a Vanguard id such as "7555", "M219", or "VMFXX".',
        );
    }

    return fundId;
}

/**
 * Records this page view with Google Analytics 4 Measurement Protocol.
 * Fire-and-forget: errors are logged but do not affect the response.
 *
 * @param {Object}  req  Cloud Function request context.
 */
export function googleAnalyticsTrack(req) {
    if (!GA_MEASUREMENT_ID || !GA_API_SECRET || !req.url) {
        return;
    }

    const url = `mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;
    gaInstance.post(url, {
        client_id: crypto.randomUUID(),
        events: [{
            name: 'page_view',
            params: {
                page_location: req.url,
            },
        }],
    }).catch((err) => {
        console.log('GA4 tracking error:', err.message);
    });
}

/**
 * Decides whether an upstream 404 means the fund truly doesn't exist (404) or
 * Vanguard is failing (500). Always rethrows.
 */
async function classifyUpstream404(err, fundId, requestLogFields) {
    if (!isUpstream404(err)) throw err;

    if (KNOWN_FUNDS.has(fundId)) {
        throw new UpstreamError(`Vanguard returned 404 for known fund ${fundId}`);
    }

    try {
        await fetchWithLog('profile', `/rs/ire/01/pe/fund/${CANARY_FUND}/profile/.json`,
            { ...requestLogFields, canary: CANARY_FUND },
            { httpsAgent: new https.Agent({ keepAlive: false }) });
    } catch (canaryErr) {
        throw new UpstreamError(
            `Vanguard returned 404 for ${fundId} and canary fund ${CANARY_FUND} also failed: ${canaryErr.message}`);
    }
    throw err;
}

/**
 * Queries an undocumented Vanguard API to return information
 * in XML format about specific funds. Useful for importing into
 * Google Sheets with the IMPORTXML() function.
 *
 *
 * @param {Object}  req  Cloud Function request context.
 * @param {Object}  res  Cloud Function response context.
 * @return {Promise}    A promise.
 */
async function vanguardFetch(req, res) {
    let params;
    for (const route of routes) {
        params = route.match(req.url);
        if (params) break;
    }
    if (!params) {
        throw new IllegalArgumentError('Fund missing from url, e.g. "https://example.com/vanguard/fundId"');
    }

    const fundId = normalizeAndValidateFundId(params.fund);

    const requestLogFields = {
        fund: fundId,
        path: req.url,
    };

    const [profileData, priceData, performanceData, expenseData] = await Promise.all([
        // profileData endpoint: keep only fields required by downstream XML output.
        fetchWithRetry('profile', `/rs/ire/01/pe/fund/${fundId}/profile/.json`, requestLogFields)
            .then((data) => {
                const profile = data?.fundProfile || {};
                return {
                    fundId: profile.fundId,
                    ticker: profile.ticker,
                    longName: profile.longName,
                    shortName: profile.shortName,
                    category: profile.category,
                    expenseRatio: profile.expenseRatio,
                    cusip: profile.cusip,
                    citFundId: profile.citFundId,
                    associatedFundIds: profile.associatedFundIds || {},
                };
            }),

        // priceData endpoint: retain just the regular daily price object.
        fetchWithRetry('price', `/rs/ire/01/pe/fund/${fundId}/price/.json`, requestLogFields)
            .then((data) => ({
                regularPrice: data?.currentPrice?.dailyPrice?.regular || {},
            })),

        // performanceData endpoint: retain only month-end annual return structure.
        fetchWithRetry('performance', `/rs/ire/01/pe/fund/${fundId}/performance/.json`, requestLogFields)
            .then((data) => ({
                monthEndAvgAnnualRtn: data?.monthEndAvgAnnualRtn || {},
            })),

        // expenseData endpoint: retain only expense ratio used in final XML.
        fetchWithRetry('expense', `/rs/ire/01/pe/fund/${fundId}/expense/.json`, requestLogFields)
            .then((data) => ({
                expenseRatio: data?.expenseRatio,
            })),
    ]).catch((err) => classifyUpstream404(err, fundId, requestLogFields));

    const profile = profileData || {};
    const price = priceData.regularPrice || {};
    const performance = performanceData.monthEndAvgAnnualRtn || {};
    const expense = expenseData || {};

    const fundIds = profile.associatedFundIds || {};

    const fundReturn = performance.fundReturn || {};
    const benchmarkReturn = performance.benchmarkReturn || {};

    const funds = [
        {
            fund: [
                { id: profile.fundId },
                { ticker: profile.ticker },
                { name: profile.longName.trim() },
                { shortName: profile.shortName.trim() },
                { category: profile.category.trim() },

                // Price
                { price: price.price },
                { priceAsOfDate: price.asOfDate },
                { expenseRatio: expense.expenseRatio || profile.expenseRatio },

                // Average annual returns-updated monthly
                {
                    fundReturn: [
                        { tenYrPct: fundReturn.tenYrPct },
                        { fiveYrPct: fundReturn.fiveYrPct },
                        { threeYrPct: fundReturn.threeYrPct },
                        { oneYrPct: fundReturn.oneYrPct },
                        { threeMonthPct: fundReturn.threeMonthPct },
                    ]
                },
                {
                    benchmarkReturn: [
                        { name: benchmarkReturn.name.trim() },
                        { tenYrPct: benchmarkReturn.tenYrPct },
                        { fiveYrPct: benchmarkReturn.fiveYrPct },
                        { threeYrPct: benchmarkReturn.threeYrPct },
                        { oneYrPct: benchmarkReturn.oneYrPct },
                        { threeMonthPct: benchmarkReturn.threeMonthPct },
                    ]
                },

                // Fund IDs
                { cusip: profile.cusip },
                { citFundId: profile.citFundId }, // Collective Investment Trust
                { admiralFundId: fundIds.admiralFundId },
                { etfFundId: fundIds.etfFundId },
                { investorFundId: fundIds.investorFundId },
                { institutionalFundId: fundIds.institutionalFundId },
                { institutionalPlusFundId: fundIds.institutionalPlusFundId },
            ]
        },
    ];

    res.status(200).set({
        'Content-Type': 'text/xml',

        // TODO(bramp) Set expire date instead for close of market.
        'Cache-Control': 'max-age=21600',
    }).send(xml(funds, true));
};

/**
 * Wrapper around the actual function to ensure errors return
 * an appropriate XML error page.
 *
 * @param {Object}  req  Cloud Function request context.
 * @param {Object}  res  Cloud Function response context.
 */
export const vanguard = async (req, res) => {
    const startedAt = Date.now();
    const traceId = getTraceId(req);
    const requestFields = {
        traceId,
        method: req.method,
        path: req.url,
        memoryMiB: memoryUsageMiB(),
    };

    if (LOG_REQUEST_LIFECYCLE) {
        logEvent('INFO', 'request started', requestFields);
    }
    googleAnalyticsTrack(req);

    try {
        await vanguardFetch(req, res);
        if (LOG_REQUEST_LIFECYCLE) {
            logEvent('INFO', 'request completed', {
                ...requestFields,
                durationMs: Date.now() - startedAt,
                status: res.statusCode,
                memoryMiB: memoryUsageMiB(),
            });
        }
    } catch (err) {
        let status = 500;
        if (err instanceof IllegalArgumentError) {
            status = 412;
        } else if (err instanceof UpstreamError) {
            status = 500;
        } else if (Number(err?.status) >= 400 && Number(err?.status) < 500) {
            status = Number(err.status);
        } else {
            const upstreamStatus = Number(err?.response?.status);
            if (upstreamStatus >= 400 && upstreamStatus < 500) {
                status = upstreamStatus;
            }
        }

        if (status >= 500 || LOG_REQUEST_LIFECYCLE) {
            logEvent((status >= 500) ? 'ERROR' : 'INFO', 'request failed', {
                ...requestFields,
                durationMs: Date.now() - startedAt,
                status,
                error: err.message,
                memoryMiB: memoryUsageMiB(),
            });
        }

        const error = [
            {
                error: [
                    { message: err.message },
                ]
            },
        ];

        res.status(status).set({
            'Content-Type': 'text/xml',
        }).send(xml(error, true));
    }
};

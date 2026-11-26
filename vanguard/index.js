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
import dns from 'dns';
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

/*
 * Workaround for false 404s from api.vanguard.com (observed November 2026).
 *
 * api.vanguard.com is a CNAME to Akamai's traffic manager
 * (api.vanguard.com.akadns.net), which normally resolves to Vanguard's own
 * servers. They always send `Server: Vanguard Server`, including on a real
 * 404 for an unknown fund.
 *
 * For hours at a time, the DNS resolver of some Cloud Run instances instead
 * returns Akamai edge servers (23.x.x.x) that answer every request, for every
 * fund, with an empty 404 and `Server: Apache`. Retrying on a new connection
 * does not help, because the instance's resolver keeps returning those servers.
 *
 * So a 404 without `Server: Vanguard Server` is treated as a false 404 and
 * retried once, with api.vanguard.com resolved through public DNS instead of
 * the instance's resolver. If the retry also gets a false 404, we return 500,
 * so callers such as Google Sheets don't mistake it for an unknown fund.
 *
 * Remove this once Vanguard/Akamai fix the routing. See "False 404s" in
 * README.md for how to check whether it is still needed.
 */
const VANGUARD_SERVER_HEADER = 'Vanguard Server';

export const publicResolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
publicResolver.setServers(['1.1.1.1', '8.8.8.8']);

/**
 * net.connect() `lookup` that resolves hostnames through publicResolver
 * instead of the system resolver.
 */
export function publicDnsLookup(hostname, options, callback) {
    publicResolver.resolve4(hostname).then((addresses) => {
        const address = addresses[Math.floor(Math.random() * addresses.length)];
        if (options.all) {
            callback(null, [{ address, family: 4 }]);
        } else {
            callback(null, address, 4);
        }
    }, (err) => callback(err));
}

// No keep-alive, so every retry does a fresh public DNS lookup.
export const publicDnsAgent = new https.Agent({ keepAlive: false, lookup: publicDnsLookup });

/**
 * Returns true if Vanguard returned a 404 that didn't come from Vanguard's
 * own servers (see the workaround comment above).
 */
function isFalse404(err) {
    return err?.response?.status === 404
        && err.response.headers?.server !== VANGUARD_SERVER_HEADER;
}

/**
 * Fetches a Vanguard API path, retrying a false 404 once via public DNS.
 */
async function fetchVanguard(name, path, logFields) {
    try {
        return await fetchWithLog(name, path, logFields);
    } catch (err) {
        if (!isFalse404(err)) throw err;
    }

    try {
        return await fetchWithLog(name, path, { ...logFields, retry: 'public-dns' }, { httpsAgent: publicDnsAgent });
    } catch (err) {
        if (isFalse404(err)) {
            throw new UpstreamError('Vanguard API returned an invalid 404 response; try again later');
        }
        throw err;
    }
}

function connectionFields(response, request = response?.request) {
    return {
        remoteAddress: request?.socket?.remoteAddress || null,
        server: response?.headers?.server || null,
    };
}

async function fetchWithLog(name, path, logFields, config) {
    const start = Date.now();
    const upstreamUrl = new URL(path, instance.defaults.baseURL).toString();
    try {
        const response = await instance.get(path, config);
        // Always log retry successes, to confirm the false 404 workaround works.
        if (LOG_UPSTREAM_REQUESTS || logFields.retry) {
            const durationMs = Date.now() - start;
            logEvent('INFO', `upstream ${name} ${response.status} ${durationMs}ms`, {
                ...logFields,
                upstream: name,
                upstreamUrl,
                durationMs,
                status: response.status,
                ...connectionFields(response),
            });
        }
        return response.data;
    } catch (err) {
        // Axios throws on non-2xx responses and network failures; log and rethrow.
        const durationMs = Date.now() - start;
        const upstreamStatus = err.response?.status || null;
        const outcome = isFalse404(err) ? 'false 404' : `failed${upstreamStatus ? ` ${upstreamStatus}` : ''}`;
        logEvent(isFalse404(err) ? 'WARNING' : 'ERROR', `upstream ${name} ${outcome} ${durationMs}ms: ${err.message}`, {
            ...logFields,
            upstream: name,
            upstreamUrl,
            durationMs,
            status: upstreamStatus,
            error: err.message,
            ...connectionFields(err.response, err.response?.request || err.request),
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
 * Error for when the Vanguard API misbehaves; always reported as a 500.
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
        fetchVanguard('profile', `/rs/ire/01/pe/fund/${fundId}/profile/.json`, requestLogFields)
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
        fetchVanguard('price', `/rs/ire/01/pe/fund/${fundId}/price/.json`, requestLogFields)
            .then((data) => ({
                regularPrice: data?.currentPrice?.dailyPrice?.regular || {},
            })),

        // performanceData endpoint: retain only month-end annual return structure.
        fetchVanguard('performance', `/rs/ire/01/pe/fund/${fundId}/performance/.json`, requestLogFields)
            .then((data) => ({
                monthEndAvgAnnualRtn: data?.monthEndAvgAnnualRtn || {},
            })),

        // expenseData endpoint: retain only expense ratio used in final XML.
        fetchVanguard('expense', `/rs/ire/01/pe/fund/${fundId}/expense/.json`, requestLogFields)
            .then((data) => ({
                expenseRatio: data?.expenseRatio,
            })),
    ]);

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

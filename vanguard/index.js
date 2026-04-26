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

async function fetchWithLog(name, path, requestLogFields) {
    const start = Date.now();
    try {
        const response = await instance.get(path);
        if (LOG_UPSTREAM_REQUESTS) {
            logEvent('INFO', 'upstream response', {
                ...requestLogFields,
                upstream: name,
                durationMs: Date.now() - start,
                status: response.status,
                contentLength: response.headers?.['content-length'] || null,
            });
        }
        return response.data;
    } catch (err) {
        // Axios throws on non-2xx responses and network failures; log and rethrow.
        logEvent('ERROR', 'upstream request failed', {
            ...requestLogFields,
            upstream: name,
            durationMs: Date.now() - start,
            status: err.response?.status || null,
            error: err.message,
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

const routes = [
    new Route('/vanguard/:fund'),  // cloudfunctions.net path (includes function name)
    new Route('/:fund'),            // run.app path (no function name prefix)
];

/**
 * Error for when there are illegal arguments passed to a function.
 */
class IllegalArgumentError extends Error { }

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

    const url = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;
    axios.post(url, {
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

    const requestLogFields = {
        fund: params.fund,
        path: req.url,
    };

    const [profileData, priceData, performanceData, expenseData] = await Promise.all([
        // profileData endpoint: keep only fields required by downstream XML output.
        fetchWithLog('profile', `/rs/ire/01/pe/fund/${params.fund}/profile/.json`, requestLogFields)
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
        fetchWithLog('price', `/rs/ire/01/pe/fund/${params.fund}/price/.json`, requestLogFields)
            .then((data) => ({
                regularPrice: data?.currentPrice?.dailyPrice?.regular || {},
            })),

        // performanceData endpoint: retain only month-end annual return structure.
        fetchWithLog('performance', `/rs/ire/01/pe/fund/${params.fund}/performance/.json`, requestLogFields)
            .then((data) => ({
                monthEndAvgAnnualRtn: data?.monthEndAvgAnnualRtn || {},
            })),

        // expenseData endpoint: retain only expense ratio used in final XML.
        fetchWithLog('expense', `/rs/ire/01/pe/fund/${params.fund}/expense/.json`, requestLogFields)
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
        'Cache-Control': 'max-age=86400',
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
        const status = (err instanceof IllegalArgumentError) ? 412 : 500;

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

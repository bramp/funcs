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

export const instance = axios.create({
    baseURL: 'https://api.vanguard.com/',
    timeout: 20000,
    headers: { 'Referer': 'https://investor.vanguard.com/' },
    httpsAgent: new https.Agent({ keepAlive: true }),
});

const route = new Route('/:fund');

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
    const params = route.match(req.url);
    if (!params) {
        throw new IllegalArgumentError('Fund missing from url, e.g. "https://example.com/vanguard/fundId"');
    }

    const [profileRes, priceRes, performanceRes, expenseRes] = await Promise.all([
        instance.get(`/rs/ire/01/pe/fund/${params.fund}/profile/.json`),
        instance.get(`/rs/ire/01/pe/fund/${params.fund}/price/.json`),
        instance.get(`/rs/ire/01/pe/fund/${params.fund}/performance/.json`),
        instance.get(`/rs/ire/01/pe/fund/${params.fund}/expense/.json`),
    ]);


    const profile = profileRes.data.fundProfile || {};
    const price = priceRes.data.currentPrice.dailyPrice.regular || {};
    const performance = performanceRes.data.monthEndAvgAnnualRtn || {};
    const expense = expenseRes.data || {};

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

                // Average annual returns—updated monthly
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
    googleAnalyticsTrack(req);

    try {
        await vanguardFetch(req, res);
    } catch (err) {
        console.log(err);

        const status = (err instanceof IllegalArgumentError) ? 412 : 500;
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

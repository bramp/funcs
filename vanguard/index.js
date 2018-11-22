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
'use strict';

const axios = require('axios');
const https = require('https');
const Route = require('route-parser');
const xml = require('xml');
const ua = require('universal-analytics');

const UA_ACCOUNT_ID = 'UA-136478-9';

const instance = axios.create({
    baseURL: 'https://api.vanguard.com/',
    timeout: 20000,
    headers: {'Referer': 'https://investor.vanguard.com/'},
    httpsAgent: new https.Agent({keepAlive: true}),
});

const route = new Route('/:fund');

/**
 * Error for when there are illegal arguments passed to a function.
 */
class IllegalArgumentError extends Error {}

/**
 * Records this page view with Google Analytics.
 *
 * @param {Object}  req  Cloud Function request context.
 */
function googleAnalyticsTrack(req) {
    const visitor = ua(UA_ACCOUNT_ID, {https: true});
    visitor.pageview(req.url, function(err) {
        if (err) {
            console.log(err);
        }
    }).send();
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
function vanguard(req, res) {
    const params = route.match(req.url);
    if (!params) {
        throw new IllegalArgumentError('Missing fund');
    }

    return axios.all([
        instance.get(`/rs/ire/01/pe/fund/${params.fund}/profile/.json`),
        instance.get(`/rs/ire/01/pe/fund/${params.fund}/price/.json`),
        instance.get(`/rs/ire/01/pe/fund/${params.fund}/performance/.json`),
    ])
    .then(axios.spread((profileRes, priceRes, performanceRes) => {
        const profile = profileRes.data.fundProfile || {};
        const price = priceRes.data.currentPrice.dailyPrice.regular || {};
        const performance = performanceRes.data.monthEndAvgAnnualRtn || {};

        const fundIds = profile.associatedFundIds || {};

        const fundReturn = performance.fundReturn || {};
        const benchmarkReturn = performance.benchmarkReturn || {};

        const funds = [
            {fund: [
                {id: profile.fundId},
                {ticker: profile.ticker},
                {name: profile.longName.trim()},
                {shortName: profile.shortName.trim()},
                {category: profile.category.trim()},

                // Price
                {price: price.price},
                {priceAsOfDate: price.asOfDate},
                {expenseRatio: profile.expenseRatio},

                // Average annual returns—updated monthly
                {fundReturn: [
                    {tenYrPct: fundReturn.tenYrPct},
                    {fiveYrPct: fundReturn.fiveYrPct},
                    {threeYrPct: fundReturn.threeYrPct},
                    {oneYrPct: fundReturn.oneYrPct},
                    {threeMonthPct: fundReturn.threeMonthPct},
                ]},
                {benchmarkReturn: [
                    {name: benchmarkReturn.name.trim()},
                    {tenYrPct: benchmarkReturn.tenYrPct},
                    {fiveYrPct: benchmarkReturn.fiveYrPct},
                    {threeYrPct: benchmarkReturn.threeYrPct},
                    {oneYrPct: benchmarkReturn.oneYrPct},
                    {threeMonthPct: benchmarkReturn.threeMonthPct},
                ]},

                // Fund IDs
                {cusip: profile.cusip},
                {citFundId: profile.citFundId}, // Collective Investment Trust
                {admiralFundId: fundIds.admiralFundId},
                {etfFundId: fundIds.etfFundId},
                {investorFundId: fundIds.investorFundId},
                {institutionalFundId: fundIds.institutionalFundId},
                {institutionalPlusFundId: fundIds.institutionalPlusFundId},
            ]},
        ];
        res.status(200).header({
            'Content-Type': 'text/xml',

            // TODO(bramp) Set expire date instead for close of market.
            'Cache-Control': 'max-age=86400',
        }).send(xml(funds, true));
    }))
    .catch((err) => {
        if (err.request) {
            const url = err.request.path;
            throw new Error('Failed to fetch "' + url + '": ' + err);
        }
        throw new Error('Failed to fetch data from Vanguard: ' + err);
    });
};


/**
 * Returns a promise which is rejected after the duration.
 *
 * @param   {int}     duration  The duration in milliseconds
 * @return  {Promise}           A Promise.
 */
function timeout(duration) {
    return new Promise(function(_, reject) {
        setTimeout(() => {
            reject(new Error('timeout after ' + duration + 'ms'));
        }, duration);
    });
}

/**
 * Wrapper around the actual function, to ensure it runs within a timeout, and
 * if an error occurs an appropraite XML error page is returned.
 *
 * TODO Move this into some kind of middleware.
 *
 * @param {Object}  req  Cloud Function request context.
 * @param {Object}  res  Cloud Function response context.
 */
exports.vanguard = (req, res) => {
    // TODO googleAnalyticsTrack is async, and may not finish before res.send
    // is called (which would mean it gets cancelled).
    googleAnalyticsTrack(req);

    Promise.race([
        timeout(30000),
        vanguard(req, res),
    ]).catch((err) => {
        console.log(err);

        const status = (err instanceof IllegalArgumentError) ? 412 : 500;
        const error = [
            {error: [
                {message: err.message},
            ]},
        ];

        res.status(status).header({
            'Content-Type': 'text/xml',
        }).send(xml(error, true));
    });
};

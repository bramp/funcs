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

import test from 'ava';
import sinon from 'sinon';
import { parseString } from 'xml2js';
import { mockReq, mockRes } from 'sinon-express-mock';
import { vanguard, instance, googleAnalyticsTrack } from './index.js';

test.beforeEach((t) => {
  t.context.sandbox = sinon.createSandbox();
  t.context.sandbox.stub({ googleAnalyticsTrack }, 'googleAnalyticsTrack');
});

test.afterEach((t) => {
  t.context.sandbox.restore();
});

test.serial(
  'vanguard: should return a error when fund is missing',
  async (t) => {
    // Initialize mocks
    const req = mockReq({ url: '' }); // Empty URL should fail match
    const res = mockRes();

    // Call tested function
    await vanguard(req, res);

    // Verify behavior of tested function
    t.true(res.send.calledOnce);
    t.is(res.status.lastCall.args[0], 412);
    t.is(res.set.lastCall.args[0]['Content-Type'], 'text/xml');

    await new Promise((resolve, reject) => {
      parseString(res.send.lastCall.args[0], function (err, result) {
        if (err) return reject(err);
        t.is(
          result.error.message[0],
          'Fund missing from url, e.g. "https://example.com/vanguard/fundId"',
        );
        resolve();
      });
    });
  },
);

test.serial('vanguard: fetch fund', async (t) => {
  // Initialize mocks
  const req = mockReq({ url: '/1234' });
  const res = mockRes();

  const instanceGet = t.context.sandbox.stub(instance, 'get');
  instanceGet.withArgs(sinon.match(/profile/)).resolves({
    data: {
      fundProfile: {
        fundId: '1234',
        ticker: 'TICK',
        longName: 'Long Name',
        shortName: 'Short Name',
        category: 'Category',
        expenseRatio: '0.1',
        cusip: 'CUSIP',
      },
    },
  });
  instanceGet.withArgs(sinon.match(/price/)).resolves({
    data: {
      currentPrice: {
        dailyPrice: {
          regular: {
            price: '100.00',
            asOfDate: '2024-01-01',
          },
        },
      },
    },
  });
  instanceGet.withArgs(sinon.match(/performance/)).resolves({
    data: {
      monthEndAvgAnnualRtn: {
        fundReturn: {
          tenYrPct: '10',
          fiveYrPct: '5',
          threeYrPct: '3',
          oneYrPct: '1',
          threeMonthPct: '0.5',
        },
        benchmarkReturn: {
          name: 'Benchmark',
          tenYrPct: '9',
          fiveYrPct: '4',
          threeYrPct: '2',
          oneYrPct: '0.5',
          threeMonthPct: '0.2',
        },
      },
    },
  });
  instanceGet.withArgs(sinon.match(/expense/)).resolves({
    data: {
      expenseRatio: '0.0150',
      expenseRatioAsOfDate: '2025-12-31T00:00:00-05:00',
    },
  });

  // Call tested function
  await vanguard(req, res);

  // Verify behavior of tested function
  t.true(res.send.calledOnce);
  t.is(res.status.lastCall.args[0], 200);
  t.is(res.set.lastCall.args[0]['Content-Type'], 'text/xml');

  await new Promise((resolve, reject) => {
    parseString(res.send.lastCall.args[0], function (err, result) {
      if (err) return reject(err);
      t.is(result.fund.id[0], '1234');
      t.is(result.fund.ticker[0], 'TICK');
      resolve();
    });
  });
});

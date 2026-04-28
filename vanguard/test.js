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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'ava';
import sinon from 'sinon';
import { parseString } from 'xml2js';
import { mockReq, mockRes } from 'sinon-express-mock';
import { vanguard, instance, googleAnalyticsTrack, normalizeAndValidateFundId } from './index.js';

const execFileAsync = promisify(execFile);

function setupSuccessfulUpstream(instanceGet) {
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
}

async function assertXmlErrorResponse(t, res, status, message) {
  t.true(res.send.calledOnce);
  t.is(res.status.lastCall.args[0], status);
  t.is(res.set.lastCall.args[0]['Content-Type'], 'text/xml');

  await new Promise((resolve, reject) => {
    parseString(res.send.lastCall.args[0], function (err, result) {
      if (err) return reject(err);
      t.is(result.error.message[0], message);
      resolve();
    });
  });
}

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
  setupSuccessfulUpstream(instanceGet);

  // Call tested function
  await vanguard(req, res);

  // Verify behavior of tested function
  t.true(res.send.calledOnce);
  t.is(res.status.lastCall.args[0], 200);
  t.is(res.set.lastCall.args[0]['Content-Type'], 'text/xml');
  t.is(res.set.lastCall.args[0]['Cache-Control'], 'max-age=21600');

  await new Promise((resolve, reject) => {
    parseString(res.send.lastCall.args[0], function (err, result) {
      if (err) return reject(err);
      t.is(result.fund.id[0], '1234');
      t.is(result.fund.ticker[0], 'TICK');
      resolve();
    });
  });
});

test.serial('vanguard: upstream http error returns 500 xml error', async (t) => {
  const req = mockReq({ url: '/1234' });
  const res = mockRes();

  const instanceGet = t.context.sandbox.stub(instance, 'get');
  instanceGet.rejects(new Error('Request failed with status code 503'));

  await vanguard(req, res);

  t.true(res.send.calledOnce);
  t.is(res.status.lastCall.args[0], 500);
  t.is(res.set.lastCall.args[0]['Content-Type'], 'text/xml');

  await new Promise((resolve, reject) => {
    parseString(res.send.lastCall.args[0], function (err, result) {
      if (err) return reject(err);
      t.is(result.error.message[0], 'Request failed with status code 503');
      resolve();
    });
  });
});

test.serial('vanguard: upstream network error returns 500 xml error', async (t) => {
  const req = mockReq({ url: '/1234' });
  const res = mockRes();

  const instanceGet = t.context.sandbox.stub(instance, 'get');
  instanceGet.rejects(new Error('socket hang up'));

  await vanguard(req, res);

  t.true(res.send.calledOnce);
  t.is(res.status.lastCall.args[0], 500);
  t.is(res.set.lastCall.args[0]['Content-Type'], 'text/xml');

  await new Promise((resolve, reject) => {
    parseString(res.send.lastCall.args[0], function (err, result) {
      if (err) return reject(err);
      t.is(result.error.message[0], 'socket hang up');
      resolve();
    });
  });
});

test.serial('vanguard: non-vanguard ticker returns 400 without upstream call', async (t) => {
  const req = mockReq({ url: '/AAPL' });
  const res = mockRes();

  const instanceGet = t.context.sandbox.stub(instance, 'get');

  await vanguard(req, res);

  t.true(instanceGet.notCalled);
  await assertXmlErrorResponse(
    t,
    res,
    400,
    'Invalid fund id format. Expected a Vanguard id such as "7555", "M219", or "VMFXX".',
  );
});

test.serial('vanguard: accepts 5-letter vanguard ticker format', async (t) => {
  const req = mockReq({ url: '/VMFXX' });
  const res = mockRes();

  const instanceGet = t.context.sandbox.stub(instance, 'get');
  setupSuccessfulUpstream(instanceGet);

  await vanguard(req, res);

  t.true(instanceGet.called);
  t.is(res.status.lastCall.args[0], 200);
});

test.serial('vanguard: accepts M plus 3 digits format', async (t) => {
  const req = mockReq({ url: '/M219' });
  const res = mockRes();

  const instanceGet = t.context.sandbox.stub(instance, 'get');
  setupSuccessfulUpstream(instanceGet);

  await vanguard(req, res);

  t.true(instanceGet.called);
  t.is(res.status.lastCall.args[0], 200);
});

test.serial('vanguard: upstream 404 for valid fund id returns 404 xml error', async (t) => {
  const req = mockReq({ url: '/1234' });
  const res = mockRes();

  const instanceGet = t.context.sandbox.stub(instance, 'get');
  const err = new Error('Request failed with status code 404');
  err.response = { status: 404 };
  instanceGet.rejects(err);

  await vanguard(req, res);

  await assertXmlErrorResponse(t, res, 404, 'Request failed with status code 404');
});

// All known-valid fund identifiers (ticker symbols and plan fund IDs).
// ticker: public exchange symbol, or null for plan-only funds.
// id: Vanguard internal plan fund ID.
const knownFunds = [
  { ticker: null,    id: '8317', name: 'EARNEST Partners Smid Cap Core Fund Founders Class' },
  { ticker: null,    id: 'N488', name: 'Fidelity® Diversified International Commingled Pool Class C' },
  { ticker: null,    id: '8880', name: 'Parnassus US Large Cap' },
  { ticker: 'PIMIX', id: '3926', name: 'PIMCO Income Fund Institutional Class' },
  { ticker: null,    id: '8074', name: 'Prudential Core Plus Bond Fund 15' },
  { ticker: null,    id: '8561', name: 'Vanguard Developed Markets Index Trust' },
  { ticker: 'VEMRX', id: '1865', name: 'Vanguard Emerging Markets Stock Index Fund Institutional Plus Shares' },
  { ticker: null,    id: 'M219', name: 'Vanguard Institutional 500 Index Trust' },
  { ticker: null,    id: '7553', name: 'Vanguard Institutional Extended Market Index Trust' },
  { ticker: null,    id: '7555', name: 'Vanguard Institutional Total Bond Market Index Trust' },
  { ticker: 'VGSNX', id: '3123', name: 'Vanguard Real Estate Index Fund Institutional Shares' },
  { ticker: null,    id: '0338', name: 'Vanguard Retirement Savings Trust II' },
  { ticker: null,    id: '7737', name: 'Vanguard Target Retirement 2020 Trust' },
  { ticker: null,    id: '7738', name: 'Vanguard Target Retirement 2025 Trust' },
  { ticker: null,    id: '7739', name: 'Vanguard Target Retirement 2030 Trust' },
  { ticker: null,    id: '7740', name: 'Vanguard Target Retirement 2035 Trust' },
  { ticker: null,    id: '7741', name: 'Vanguard Target Retirement 2040 Trust' },
  { ticker: null,    id: '7742', name: 'Vanguard Target Retirement 2045 Trust' },
  { ticker: null,    id: '7743', name: 'Vanguard Target Retirement 2050 Trust' },
  { ticker: null,    id: '7744', name: 'Vanguard Target Retirement 2055 Trust' },
  { ticker: null,    id: '7745', name: 'Vanguard Target Retirement 2060 Trust' },
  { ticker: null,    id: '7746', name: 'Vanguard Target Retirement 2065 Trust' },
  { ticker: null,    id: 'M013', name: 'Vanguard Target Retirement 2070 Trust' },
  { ticker: null,    id: 'M012', name: 'Vanguard Target Retirement Income and Growth Trust' },
  { ticker: null,    id: '7735', name: 'Vanguard Target Retirement Income Trust' },
  { ticker: 'VTIFX', id: '2011', name: 'Vanguard Total International Bond Index Fund Institutional Shares' },
  { ticker: 'VWIAX', id: '0527', name: 'Vanguard Wellesley Income Fund Admiral Shares' },
];

test('normalizeAndValidateFundId: accepts all known valid ids', (t) => {
  for (const { ticker, id } of knownFunds) {
    t.notThrows(() => normalizeAndValidateFundId(id), `expected plan fund id ${id} to be valid`);
    if (ticker) {
      t.notThrows(() => normalizeAndValidateFundId(ticker), `expected ticker ${ticker} to be valid`);
    }
  }
});

test('normalizeAndValidateFundId: rejects invalid ids', (t) => {
  const invalid = ['AAPL', 'N/A', '', 'TOOLONG1', '123', 'AB', '—'];
  for (const id of invalid) {
    t.throws(() => normalizeAndValidateFundId(id), { instanceOf: Error }, `expected ${id} to be invalid`);
  }
});

const endpointFailures = [
  { name: 'profile', matcher: /profile/ },
  { name: 'price', matcher: /price/ },
  { name: 'performance', matcher: /performance/ },
  { name: 'expense', matcher: /expense/ },
];

endpointFailures.forEach(({ name, matcher }) => {
  test.serial(`vanguard: ${name} failure returns 500 xml error`, async (t) => {
    const req = mockReq({ url: '/1234' });
    const res = mockRes();
    const instanceGet = t.context.sandbox.stub(instance, 'get');
    const errorMessage = `${name} endpoint failed`;

    setupSuccessfulUpstream(instanceGet);
    instanceGet.withArgs(sinon.match(matcher)).rejects(new Error(errorMessage));

    await vanguard(req, res);

    await assertXmlErrorResponse(t, res, 500, errorMessage);
  });
});

test('bench-memory: smoke test runs without error', async (t) => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--expose-gc', './bench-memory.js'],
    {
      cwd: new URL('.', import.meta.url).pathname,
      env: {
        ...process.env,
        BENCH_TIME_MS: '100',
        BENCH_WARMUP_TIME_MS: '50',
        BENCH_CONCURRENCY: '2',
        BENCH_FUNDS: '1234',
      },
      timeout: 30000,
    },
  );
  t.true(stdout.includes('Throughput and latency'), `expected benchmark output, got: ${stdout}`);
});

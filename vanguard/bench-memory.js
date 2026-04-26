import { Bench } from 'tinybench';
import { createMockServer } from './bench/createMockServer.js';

const TIME_MS = Number(process.env.BENCH_TIME_MS || '3000');
const WARMUP_TIME_MS = Number(process.env.BENCH_WARMUP_TIME_MS || '1000');
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY || '20');
const MOCK_DELAY_MS = Number(process.env.BENCH_MOCK_DELAY_MS || '0');
const FUNDS = (process.env.BENCH_FUNDS || '1234,1235,1236,1237,1238,1239,1240,1241,1242,1243')
  .split(',')
  .map((fund) => fund.trim())
  .filter(Boolean);

function toMiB(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function memorySnapshot() {
  const m = process.memoryUsage();
  return {
    rssMiB: toMiB(m.rss),
    heapUsedMiB: toMiB(m.heapUsed),
    heapTotalMiB: toMiB(m.heapTotal),
    externalMiB: toMiB(m.external),
    arrayBuffersMiB: toMiB(m.arrayBuffers),
  };
}

function forceGc() {
  if (global.gc) {
    global.gc();
  }
}

function makeReq(url) {
  return { url };
}

function makeRes() {
  return {
    _status: 200,
    _headers: {},
    _body: '',
    status(code) {
      this._status = code;
      return this;
    },
    set(headers) {
      this._headers = headers;
      return this;
    },
    send(body) {
      this._body = body;
      return this;
    },
  };
}

function printTable(rows) {
  console.table(rows);
}

async function main() {
  if (FUNDS.length === 0) {
    throw new Error('BENCH_FUNDS must include at least one fund ID');
  }

  const { server, port, getRequestCount } = await createMockServer(
    (await import('node:http')),
    { delayMs: MOCK_DELAY_MS },
  );

  try {
    process.env.GA_MEASUREMENT_ID = '';
    process.env.GA_API_SECRET = '';
    const mockBaseUrl = `http://127.0.0.1:${port}`;
    process.env.VANGUARD_BASE_URL = `${mockBaseUrl}/`;

    // Import after env configuration so axios picks up VANGUARD_BASE_URL.
    const { vanguard } = await import(`./index.js?bench=${Date.now()}`);
    let requestCounter = 0;

    const bench = new Bench({
      time: TIME_MS,
      warmupTime: WARMUP_TIME_MS,
      iterations: 1,
      warmupIterations: 1,
    });

    bench.add('vanguard-batch', async () => {
      const startIndex = requestCounter;
      requestCounter += CONCURRENCY;

      const tasks = Array.from({ length: CONCURRENCY }, (_, i) => {
        const fund = FUNDS[(startIndex + i) % FUNDS.length];
        return vanguard(makeReq(`/vanguard/${fund}`), makeRes());
      });

      await Promise.all(tasks);
    });

    forceGc();
    const baseline = memorySnapshot();

    await bench.warmup();
    forceGc();
    const postWarmup = memorySnapshot();

    await bench.run();
    const task = bench.tasks[0];
    const result = task.result;

    forceGc();
    const postRun = memorySnapshot();

    const throughputReqPerSec = Number(((result.hz || 0) * CONCURRENCY).toFixed(2));
    const deltaRss = Number((postRun.rssMiB - baseline.rssMiB).toFixed(2));
    const deltaHeap = Number((postRun.heapUsedMiB - baseline.heapUsedMiB).toFixed(2));

    console.log('Benchmark config');
    printTable([
      { key: 'node', value: process.version },
      { key: 'benchTimeMs', value: TIME_MS },
      { key: 'warmupTimeMs', value: WARMUP_TIME_MS },
      { key: 'concurrency', value: CONCURRENCY },
      { key: 'fundCount', value: FUNDS.length },
      { key: 'mockDelayMs', value: MOCK_DELAY_MS },
      { key: 'mockBaseUrl', value: mockBaseUrl },
    ]);

    console.log('Throughput and latency');
    printTable([
      {
        metric: 'batch ops/sec',
        value: Number((result.hz || 0).toFixed(2)),
      },
      {
        metric: 'throughput req/sec',
        value: throughputReqPerSec,
      },
      {
        metric: 'mean batch latency (ms)',
        value: Number((result.mean || 0).toFixed(4)),
      },
      {
        metric: 'rme (%)',
        value: Number((result.rme || 0).toFixed(2)),
      },
    ]);

    console.log('Memory (MiB)');
    printTable([
      {
        metric: 'rss',
        baseline: baseline.rssMiB,
        postWarmup: postWarmup.rssMiB,
        postRun: postRun.rssMiB,
        delta: deltaRss,
      },
      {
        metric: 'heapUsed',
        baseline: baseline.heapUsedMiB,
        postWarmup: postWarmup.heapUsedMiB,
        postRun: postRun.heapUsedMiB,
        delta: deltaHeap,
      },
    ]);

    console.log('Request count');
    printTable([
      {
        metric: 'mockRequests',
        value: getRequestCount(),
      },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

import { performance } from 'perf_hooks';
import { createMockServer } from './bench/createMockServer.js';

const ITERATIONS = Number(process.env.BENCH_ITERATIONS || '1000');
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY || '20');
const WARMUP = Number(process.env.BENCH_WARMUP || '100');
const MOCK_DELAY_MS = Number(process.env.BENCH_MOCK_DELAY_MS || '0');
const FUNDS = (process.env.BENCH_FUNDS || '1234,1235,1236,1237,1238,1239,1240,1241,1242,1243')
  .split(',')
  .map((fund) => fund.trim())
  .filter(Boolean);
const COLD_REQUESTS = Number(process.env.BENCH_COLD_REQUESTS || String(FUNDS.length));

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

function makeReq(url = '/1234') {
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

async function runBatch(vanguard, totalRequests, concurrency) {
  const start = performance.now();
  let completed = 0;
  let peakRss = process.memoryUsage().rss;
  const seenFunds = new Set();
  const coldLatency = {
    count: 0,
    totalMs: 0,
    minMs: Number.POSITIVE_INFINITY,
    maxMs: 0,
  };
  const warmLatency = {
    count: 0,
    totalMs: 0,
    minMs: Number.POSITIVE_INFINITY,
    maxMs: 0,
  };

  const worker = async () => {
    while (completed < totalRequests) {
      const index = completed;
      completed += 1;

      const fund = FUNDS[index % FUNDS.length];
      const isCold = !seenFunds.has(fund) && coldLatency.count < COLD_REQUESTS;
      if (isCold) {
        seenFunds.add(fund);
      }

      const req = makeReq(`/vanguard/${fund}`);
      const res = makeRes();

      const reqStart = performance.now();
      await vanguard(req, res);
      const latencyMs = Number((performance.now() - reqStart).toFixed(2));

      if (isCold) {
        coldLatency.count += 1;
        coldLatency.totalMs += latencyMs;
        coldLatency.minMs = Math.min(coldLatency.minMs, latencyMs);
        coldLatency.maxMs = Math.max(coldLatency.maxMs, latencyMs);
      } else {
        warmLatency.count += 1;
        warmLatency.totalMs += latencyMs;
        warmLatency.minMs = Math.min(warmLatency.minMs, latencyMs);
        warmLatency.maxMs = Math.max(warmLatency.maxMs, latencyMs);
      }

      const rss = process.memoryUsage().rss;
      if (rss > peakRss) {
        peakRss = rss;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  return {
    durationMs: Number((performance.now() - start).toFixed(2)),
    peakRssMiB: toMiB(peakRss),
    latency: {
      coldRequests: {
        count: coldLatency.count,
        avgMs: coldLatency.count > 0
          ? Number((coldLatency.totalMs / coldLatency.count).toFixed(2))
          : 0,
        minMs: coldLatency.count > 0
          ? Number(coldLatency.minMs.toFixed(2))
          : 0,
        maxMs: coldLatency.count > 0
          ? Number(coldLatency.maxMs.toFixed(2))
          : 0,
      },
      warmRequests: {
        count: warmLatency.count,
        avgMs: warmLatency.count > 0
          ? Number((warmLatency.totalMs / warmLatency.count).toFixed(2))
          : 0,
        minMs: warmLatency.count > 0
          ? Number(warmLatency.minMs.toFixed(2))
          : 0,
        maxMs: warmLatency.count > 0
          ? Number(warmLatency.maxMs.toFixed(2))
          : 0,
      },
    },
  };
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

    forceGc();
    const baseline = memorySnapshot();

    await runBatch(vanguard, WARMUP, CONCURRENCY);
    forceGc();
    const postWarmup = memorySnapshot();

    const run = await runBatch(vanguard, ITERATIONS, CONCURRENCY);
    forceGc();
    const postRun = memorySnapshot();

    const report = {
      config: {
        node: process.version,
        iterations: ITERATIONS,
        concurrency: CONCURRENCY,
        warmup: WARMUP,
        mockDelayMs: MOCK_DELAY_MS,
        funds: FUNDS,
        coldRequests: COLD_REQUESTS,
        urlPattern: '/vanguard/:fund',
        mockBaseUrl,
        vanguardBaseUrl: process.env.VANGUARD_BASE_URL,
      },
      memory: {
        baseline,
        postWarmup,
        postRun,
        deltasMiB: {
          rss: Number((postRun.rssMiB - baseline.rssMiB).toFixed(2)),
          heapUsed: Number((postRun.heapUsedMiB - baseline.heapUsedMiB).toFixed(2)),
        },
      },
      run,
      mock: {
        requestCount: getRequestCount(),
      },
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

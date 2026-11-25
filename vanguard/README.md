# Vanguard (Google Cloud Function)

by [Andrew Brampton](https://bramp.net) 2018-2026

Fetches fund information from Vanguard and returns it in XML format.

Useful for importing information about Vanguard funds that do not have a ticker symbol, for example [Collective Investment Trust](https://www.investopedia.com/terms/c/collective-investment-fund.asp) funds, into Google Spreadsheets. For example:

```
=IMPORTXML("https://<path to cloud function>/vanguard/7555", "//fund/price")
```

```xml
<fund>
	<id>1884</id>
	<ticker/>
	<name>Vanguard Institutional Total Bond Market Index Trust</name>
	<shortName>Inst Tot Bd Mkt Ix Tr</shortName>
	<category>Intermediate-Term Bond</category>
	<price>100.01</price>
	<priceAsOfDate>2018-03-02T00:00:00-05:00</priceAsOfDate>
	<expenseRatio>0.0100</expenseRatio>
	<fundReturn>
		<tenYrPct/>
		<fiveYrPct/>
		<threeYrPct/>
		<oneYrPct/>
		<threeMonthPct/>
	</fundReturn>
	<benchmarkReturn>
		<name>BloomBarc US Agg Float Adj Index</name>
		<tenYrPct/>
		<fiveYrPct>1.71</fiveYrPct>
		<threeYrPct>1.15</threeYrPct>
		<oneYrPct>0.54</oneYrPct>
		<threeMonthPct>-1.64</threeMonthPct>
	</benchmarkReturn>
	<cusip/>
	<citFundId>7555</citFundId>
	<admiralFundId>0584</admiralFundId>
	<etfFundId>0928</etfFundId>
	<investorFundId>0084</investorFundId>
	<institutionalFundId>0222</institutionalFundId>
	<institutionalPlusFundId>0850</institutionalPlusFundId>
</fund>
```

# Tests

```shell
npm install
npm run lint
npm test
```

# Memory benchmark

Use the benchmark to measure memory and throughput before/after code changes.

It runs the function in-process with `tinybench`, sends requests across rotating fund IDs, and routes all upstream API calls to a local mock server (no real Vanguard traffic).

```shell
npm run bench:memory
```

The command prints clear tables for:

- throughput and latency (`tinybench` stats)
- memory snapshots (`baseline`, `postWarmup`, `postRun`, and deltas)
- total mock request count

You can tune benchmark behavior with environment variables:

```shell
BENCH_TIME_MS=5000 \
BENCH_WARMUP_TIME_MS=1000 \
BENCH_CONCURRENCY=50 \
BENCH_MOCK_DELAY_MS=5 \
BENCH_FUNDS=1234,1235,1236,1237,1238,1239,1240,1241,1242,1243 \
npm run bench:memory
```

Notes:

- For branch comparison, run `npm run bench:memory` on each branch with the same env vars and compare the tables.
- `BENCH_FUNDS` controls cache diversity. More unique IDs means less cache reuse.
- The function supports `VANGUARD_BASE_URL` for overriding upstream base URL (used by the benchmark to point at localhost mock server).
- Benchmark files are excluded from deploy uploads via `.gcloudignore`.

# Using the local emulator

```shell
# Start and Depliy
functions start
functions deploy vanguard --trigger-http

# Now you can change code, and it'll be reflected on the local emulator
functions call vanguard

# Check out the logs
functions logs read

# Clean up
functions stop
```

[More information here](https://cloud.google.com/functions/docs/emulator)

# Deploy

```shell
# Switch to the config for this project (if you don't have one `gcloud init`)
gcloud config configurations activate funcs

gcloud functions deploy vanguard --runtime nodejs8 --trigger-http

wget https://<path to cloud function>/vanguard/VIIIX
```

## Production troubleshooting

Vanguard is a Gen 2 function, so its request and application logs use the
`cloud_run_revision` resource:

```shell
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="vanguard"' \
  --project=bramp-projects --freshness=1d --limit=100
```

Upstream failures log the API URL, HTTP status, remote address, socket reuse,
response content type/length, server header, and network error code. Text or
binary error responses are fingerprinted with SHA-256; their bodies and cookies
are not logged. Set `LOG_UPSTREAM_REQUESTS=1` to also log successful upstream
requests and compare them by instance and remote address.

Vanguard sometimes returns 404 for funds that exist. Production logs show this
is sticky per instance: an affected instance 404s on every fund for hours. An
upstream 404 is therefore handled as follows:

1. Retry once over a fresh (non keep-alive) connection. The outcome is logged
   with `retry: true`.
2. If the fund is one of `KNOWN_FUNDS` (`VMFXX`, `7553`, `M219`, `7555`), return
   500.
3. Otherwise fetch the known fund `7555` as a canary (logged with `canary`). If
   the canary also fails, return 500; if it succeeds, the fund truly doesn't
   exist and we return 404.

### Plan: replace this with a false-404 heuristic

The retry, `KNOWN_FUNDS` list and canary check are temporary. They exist to
return the right status code while collecting data. Once we can tell a false
404 apart from a real one, they should be removed (see the `TODO` in
`index.js`).

1. **Collect data.** Deploy, then wait for an instance to go bad. Query the
   upstream logs (`jsonPayload.upstream:*`) for that instance.
2. **Is it the persistent connection?** Compare the first attempt with its
   `retry: true` attempt:
   - First attempt 404s with `reusedSocket: false`: a fresh connection still
     fails, so reused connections are not the cause.
   - First attempt 404s on a reused socket, and the retry succeeds on a fresh
     socket to the same `remoteAddress`: the connection is the cause.
   - Retry succeeds but `remoteAddress` changed: inconclusive (could be the
     connection or the Vanguard server).
   - Retry also 404s, while healthy instances get 200s from the same
     `remoteAddress`: the instance (likely its outbound IP) is the cause.
3. **Is a false 404 distinguishable?** A real "not found" (tested with `9999`,
   `ZZZZZ`, `ABCDE`) returns `Server: Vanguard Server`, `text/html`, 2662 bytes,
   with `responseBodySha256` starting `e8c37feb` and ending `29009fb`. Compare
   the false 404s' `responseBodySha256`, `contentType`, `contentLength`,
   `server` and `durationMs` (false 404s took a median of ~700 ms vs ~150 ms
   for successes).
4. **Simplify**, depending on what we find:
   - False 404s look different: treat only the known "not found" page as a
     404 and return 500 for anything else. Remove `KNOWN_FUNDS` and the canary.
   - The retry on a fresh connection fixes it: keep the retry (or disable
     keep-alive) and remove `KNOWN_FUNDS` and the canary.
   - Neither: keep the canary check but drop `KNOWN_FUNDS`, or only run the
     canary when this instance hasn't had a recent 200. If the instance's IP is
     the cause, consider a fixed outbound IP via Cloud NAT.

Check system logs for `Memory limit` when requests return 500/503. Deployment
uses 256 MiB because production exceeded the former 128 MiB limit. Increasing
memory does not address upstream 404s.

## Licence (Apache 2)

This is not an official Google product.

```
Copyright 2018 Google Inc. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

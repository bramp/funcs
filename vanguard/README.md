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

Upstream failures are logged with the API URL, HTTP status, duration, the
remote server's IP address and its `Server` header. Set
`LOG_UPSTREAM_REQUESTS=1` to also log successful upstream requests.

### False 404s

Since at least November 2026, `api.vanguard.com` sometimes returns a 404 for
funds that exist. This used to reach Google Sheets as a misleading "not found".

**Cause.** `api.vanguard.com` is a CNAME to Akamai's traffic manager
(`api.vanguard.com.akadns.net`), which normally resolves to Vanguard's own
servers (`192.175.x.83`). Those always reply with `Server: Vanguard Server`,
including the 404 HTML page for an unknown fund. For hours at a time, the DNS
resolver of some Cloud Run instances instead returns Akamai edge servers
(`23.x.x.x`) that answer every request, for every fund, with an empty 404 and
`Server: Apache`. Retrying on a new connection doesn't help, because the
instance's resolver keeps returning those servers. Querying Akamai's DNS
directly, including for Google Cloud subnets, only returned the good servers.

**Workaround** (in `index.js`):

1. A 404 without `Server: Vanguard Server` is a false 404, logged as a
   `WARNING` with message `upstream <endpoint> false 404`.
2. It is retried once, with `api.vanguard.com` resolved through public DNS
   (`1.1.1.1`, then `8.8.8.8`) instead of the instance's resolver. Retries are
   always logged with `retry: "public-dns"`. `remoteAddress` is empty on
   successful retries because the connection is already closed; a
   `Server: Vanguard Server` header confirms the retry reached Vanguard.
3. If the retry also gets a false 404, the endpoint returns 500, so callers
   don't mistake it for an unknown fund. A real 404 from Vanguard is still
   returned as 404.

**Is it still needed?** Count false 404s over the last week. If there are none,
the routing has been fixed and the workaround can be removed:

```shell
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="vanguard" AND jsonPayload.message:"false 404"' \
  --project=bramp-projects --freshness=7d --format='value(timestamp,jsonPayload.retry,jsonPayload.remoteAddress)'
```

If retries are logged as false 404s too, public DNS isn't avoiding the bad
servers either, and another approach is needed.

Check system logs for `Memory limit` when requests return 500/503. Deployment
uses 256 MiB because production exceeded the former 128 MiB limit.

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

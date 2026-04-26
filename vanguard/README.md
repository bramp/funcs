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

It runs the function in-process, sends requests across 10 rotating fund IDs (by default), and routes all upstream API calls to a local mock server (no real Vanguard traffic).

```shell
npm run bench:memory
```

The benchmark prints JSON with:

- `memory.baseline`: process memory before warmup
- `memory.postWarmup`: memory after warmup requests
- `memory.postRun`: memory after the benchmark run
- `memory.deltasMiB`: net growth from baseline (RSS + heap)
- `run.peakRssMiB`: peak RSS observed during execution
- `run.durationMs`: total run time for the measured phase
- `mock.requestCount`: number of mock upstream requests handled

You can tune benchmark behavior with environment variables:

```shell
BENCH_ITERATIONS=5000 \
BENCH_CONCURRENCY=50 \
BENCH_WARMUP=200 \
BENCH_FUNDS=1234,1235,1236,1237,1238,1239,1240,1241,1242,1243 \
npm run bench:memory
```

Notes:

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

## TODO

- [ ] Fix the tests!

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

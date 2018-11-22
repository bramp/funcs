# Vanguard (Google Cloud Function)
by [Andrew Brampton](https://bramp.net) 2018

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

gcloud beta functions deploy vanguard --trigger-http

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

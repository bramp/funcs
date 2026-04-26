function buildStubData(fundId) {
  return {
    profile: {
      data: {
        fundProfile: {
          fundId,
          ticker: `T${fundId}`,
          longName: `Long Name ${fundId}`,
          shortName: `Short Name ${fundId}`,
          category: 'Category',
          expenseRatio: '0.1',
          cusip: 'CUSIP',
          associatedFundIds: {
            admiralFundId: 'A1',
            etfFundId: 'E1',
            investorFundId: 'I1',
            institutionalFundId: 'N1',
            institutionalPlusFundId: 'P1',
          },
        },
      },
    },
    price: {
      data: {
        currentPrice: {
          dailyPrice: {
            regular: {
              price: '100.00',
              asOfDate: '2026-01-01',
            },
          },
        },
      },
    },
    performance: {
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
    },
    expense: {
      data: {
        expenseRatio: '0.0150',
      },
    },
  };
}

export function createMockServer(http, options = {}) {
  const delayMs = Number(options.delayMs || 0);
  let requestCount = 0;

  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    const path = req.url || '';
    const fundMatch = path.match(/\/fund\/([^/]+)\//);
    const fundId = fundMatch ? fundMatch[1] : '0000';
    const stub = buildStubData(fundId);

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    res.setHeader('Content-Type', 'application/json');

    if (path.includes('/profile/.json')) {
      res.end(JSON.stringify(stub.profile.data));
      return;
    }

    if (path.includes('/price/.json')) {
      res.end(JSON.stringify(stub.price.data));
      return;
    }

    if (path.includes('/performance/.json')) {
      res.end(JSON.stringify(stub.performance.data));
      return;
    }

    if (path.includes('/expense/.json')) {
      res.end(JSON.stringify(stub.expense.data));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found', path }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        getRequestCount: () => requestCount,
      });
    });
  });
}

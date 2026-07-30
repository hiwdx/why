export const MARKET_RULES = {
  US: {
    label: "美股",
    sessions: ["盘前", "盘中", "盘后"],
    minAbsoluteChangePercent: 5,
    minVolumeVs30DayAverage: 1.5,
    watchlist: [
      "AAPL",
      "MSFT",
      "GOOGL",
      "AMZN",
      "NVDA",
      "META",
      "TSLA",
      "AMD",
      "AVGO",
      "PLTR",
    ],
  },
  HK: {
    label: "港股",
    minAbsoluteChangePercent: 7,
    minMarketCapHkd: 10_000_000_000,
    minTurnoverVs30DayAverage: 1.5,
    watchlist: ["0700.HK", "9988.HK", "3690.HK", "1810.HK", "9618.HK"],
  },
} as const;

export const CROSS_MARKET_CONTEXT = {
  sourceMarket: "US",
  targetMarket: "HK",
  handoff: "美股收盘数据作为次日港股早盘分析上下文",
} as const;

export type MarketCode = keyof typeof MARKET_RULES;

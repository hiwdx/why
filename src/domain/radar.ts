import { MARKET_RULES, type MarketCode } from "../../config/rules";
import type { DeepSeekAlert, NewsContext } from "../../lib/deepseek";

export type MarketQuote = {
  symbol: string;
  market: MarketCode;
  session: "pre" | "regular" | "after";
  price: number;
  previousClose: number;
  volume: number;
  average30DayVolume: number;
  turnover?: number;
  average30DayTurnover?: number;
  marketCapHkd?: number;
};

export type TriggeredAlert = {
  id: string;
  symbol: string;
  market: MarketCode;
  session: MarketQuote["session"];
  price: number;
  previousClose: number;
  changePercent: number;
  volumeRatio: number;
  triggeredAt: string;
  ai: DeepSeekAlert;
  news: NewsContext[];
};

export function getChangePercent(quote: MarketQuote) {
  return ((quote.price - quote.previousClose) / quote.previousClose) * 100;
}

export function shouldTrigger(quote: MarketQuote, activeWatchlist?: readonly string[]): boolean {
  const changePercent = Math.abs(getChangePercent(quote));
  const watchlist = activeWatchlist ?? (MARKET_RULES[quote.market].watchlist as readonly string[]);
  if (!watchlist.includes(quote.symbol)) return false;

  if (quote.market === "US") {
    return (
      changePercent > MARKET_RULES.US.minAbsoluteChangePercent &&
      quote.volume / quote.average30DayVolume >= MARKET_RULES.US.minVolumeVs30DayAverage
    );
  }

  const turnoverRatio = quote.turnover && quote.average30DayTurnover ? quote.turnover / quote.average30DayTurnover : 0;
  return (
    (quote.marketCapHkd ?? 0) >= MARKET_RULES.HK.minMarketCapHkd &&
    changePercent > MARKET_RULES.HK.minAbsoluteChangePercent &&
    turnoverRatio >= MARKET_RULES.HK.minTurnoverVs30DayAverage
  );
}

export function createMockQuotes(symbol: string, scenario: "alert" | "quiet" = "alert"): MarketQuote[] {
  const previousClose = 184.72;
  return [
    {
      symbol,
      market: "US",
      session: "pre",
      price: scenario === "quiet" ? 184.96 : 173.64,
      previousClose,
      volume: 1_924_000,
      average30DayVolume: 1_034_000,
    },
    {
      symbol: "0700.HK",
      market: "HK",
      session: "regular",
      price: 502.6,
      previousClose: 506.2,
      volume: 2_100_000,
      average30DayVolume: 1_450_000,
      turnover: 1_055_000_000,
      average30DayTurnover: 810_000_000,
      marketCapHkd: 4_600_000_000_000,
    },
  ];
}

export function createFallbackAiAlert(symbol: string, market: MarketCode, changePercent: number, volumeRatio: number, timestamp: string, hasNews: boolean): DeepSeekAlert {
  return {
    stock_symbol: symbol,
    market,
    change_percent: `${changePercent > 0 ? "+" : ""}${changePercent.toFixed(1)}%`,
    why_one_liner: hasNews ? "外部新闻归因暂不可用，市场正在重新评估短期盈利预期。" : "未检测到明显的新闻事件催化，可能为技术面调整或资金博弈。",
    key_factors: hasNews ? [`成交量为 30 日均量的 ${(volumeRatio * 100).toFixed(0)}%，异动达到预警阈值。`, "等待模型服务恢复后补充新闻归因。"] : ["近 48 小时未获取到可用新闻 Context。", `成交量为 30 日均量的 ${(volumeRatio * 100).toFixed(0)}%，异动达到预警阈值。`],
    timestamp,
  };
}

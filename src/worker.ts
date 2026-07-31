import { createMacroErrorSummary, generateDeepSeekAlert, generateDeepSeekMacroSummary, type MacroSummary } from "../lib/deepseek";
import { buildNewsContext, fetchRecentNews, type NewsFetchResult } from "../lib/news";
import { MARKET_RULES } from "../config/rules";
import { createFallbackAiAlert, createMockQuotes, getChangePercent, shouldTrigger, type MarketQuote, type TriggeredAlert } from "./domain/radar";

export interface Env {
  WHY_DATA: KVNamespace;
  DEEPSEEK_API_KEY?: string;
  FINNHUB_API_KEY?: string;
  MARKET_DATA_MODE?: "mock" | "live";
  MOCK_SCENARIO?: "alert" | "quiet";
  HOT_TICKERS?: string;
  BLOCKED_PERSONS?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "https://why.hiwd.com",
      "vary": "origin",
    },
  });

function toPublicAlert(alert: TriggeredAlert): TriggeredAlert {
  return { ...alert, ai: { ...alert.ai, raw_response: undefined } };
}

function toPublicMacroSummary(summary: MacroSummary): MacroSummary {
  // 保留可供界面判断的失败码，但不把模型原始响应或上游错误回传给访客。
  return { ...summary, raw_response: undefined };
}

function alertHistorySignature(alert: Pick<TriggeredAlert, "market" | "symbol" | "session" | "changePercent" | "triggeredAt">) {
  return `${alert.market}_${alert.symbol}_${alert.triggeredAt.slice(0, 10)}_${alert.session}_${alert.changePercent.toFixed(1)}`;
}

type MacroMarket = "US" | "HK";
type IndexConfig = { market: MacroMarket; ticker: string; newsTicker?: string; supportingTicker?: string; indexName: string };
type IndexSnapshot = { changePercent: number; ticker: string; observedAt?: string; failed?: boolean };
type YahooChartPayload = {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        regularMarketTime?: number;
        regularMarketVolume?: number;
        previousClose?: number;
        chartPreviousClose?: number;
        marketState?: string;
      };
      indicators?: { quote?: Array<{ volume?: Array<number | null> }> };
    }>;
  };
};
type NasdaqQuotePayload = {
  data?: {
    primaryData?: { lastSalePrice?: string; volume?: string; marketStatus?: string };
    secondaryData?: { lastSalePrice?: string; netChange?: string; percentageChange?: string; lastTradeTimestamp?: string };
    summaryData?: { PreviousClose?: { value?: string } };
  };
};
type NasdaqHistoryPayload = { data?: { tradesTable?: { rows?: Array<{ volume?: string }> } } };

const MACRO_INDICES: IndexConfig[] = [
  { market: "US", ticker: "^GSPC", newsTicker: "SPY", supportingTicker: "QQQ", indexName: "S&P 500" },
  { market: "HK", ticker: "^HSI", indexName: "恒生指数" },
];

async function fetchIndexSnapshot(config: IndexConfig): Promise<IndexSnapshot> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(config.ticker)}?range=5d&interval=1d`;
  try {
    const response = await fetch(url, { headers: { "user-agent": "why.hiwd.com macro radar/1.0", accept: "application/json" } });
    if (!response.ok) throw new Error(`Yahoo index quote returned HTTP ${response.status}`);
    const payload = await response.json<{ chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; regularMarketTime?: number; previousClose?: number; chartPreviousClose?: number } }> } }>();
    const meta = payload.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    const previousClose = Number(meta?.chartPreviousClose ?? meta?.previousClose);
    if (!Number.isFinite(price) || !Number.isFinite(previousClose) || previousClose <= 0) throw new Error("Yahoo index quote payload was incomplete");
    const observedAt = Number(meta?.regularMarketTime);
    return {
      ticker: config.ticker,
      changePercent: ((price - previousClose) / previousClose) * 100,
      observedAt: Number.isFinite(observedAt) ? new Date(observedAt * 1000).toISOString() : undefined,
    };
  } catch (error) {
    console.warn(`[Macro] ${config.ticker} 行情读取失败。`, error);
    return { ticker: config.ticker, changePercent: 0, failed: true };
  }
}

async function fetchLiveUsQuote(symbol: string): Promise<MarketQuote | null> {
  // Nasdaq 返回独立的盘前价、最近收盘价和完整交易日成交量；优先使用它，
  // 避免 Yahoo 在财报跳空或盘前阶段返回错误的 chartPreviousClose。
  const nasdaqQuote = await fetchNasdaqUsQuote(symbol);
  if (nasdaqQuote) return nasdaqQuote;
  return fetchYahooUsQuote(symbol);
}

async function fetchYahooUsQuote(symbol: string): Promise<MarketQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=35d&interval=1d&events=div%2Csplits`;
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "why.hiwd.com live radar/1.0", accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Yahoo quote returned HTTP ${response.status}`);
    const payload = await response.json<YahooChartPayload>();
    const result = payload.chart?.result?.[0];
    const meta = result?.meta;
    const price = Number(meta?.regularMarketPrice);
    const previousClose = Number(meta?.chartPreviousClose ?? meta?.previousClose);
    const volumes = (result?.indicators?.quote?.[0]?.volume ?? []).map(Number).filter((value) => Number.isFinite(value) && value > 0);
    const currentVolume = Number(meta?.regularMarketVolume ?? volumes.at(-1));
    const baselineVolumes = volumes.slice(0, -1).slice(-30);
    const average30DayVolume = baselineVolumes.reduce((sum, value) => sum + value, 0) / baselineVolumes.length;
    if (!Number.isFinite(price) || !Number.isFinite(previousClose) || previousClose <= 0 || !Number.isFinite(currentVolume) || !Number.isFinite(average30DayVolume) || average30DayVolume <= 0) {
      throw new Error("Yahoo quote payload was incomplete");
    }
    const marketState = meta?.marketState;
    const session = marketState === "PRE" ? "pre" : marketState === "POST" ? "after" : "regular";
    return {
      symbol,
      market: "US",
      session,
      price,
      previousClose,
      volume: currentVolume,
      average30DayVolume,
    };
  } catch (error) {
    console.warn(`[Quote] ${symbol} 实时行情获取失败。`, error);
    return null;
  }
}

async function fetchNasdaqUsQuote(symbol: string): Promise<MarketQuote | null> {
  const headers = { "user-agent": "Mozilla/5.0 why.hiwd.com live radar/1.0", accept: "application/json, text/plain, */*" };
  try {
    const [quoteResponse, summaryResponse] = await Promise.all([
      fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=stocks`, { headers }),
      fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/summary?assetclass=stocks`, { headers }),
    ]);
    if (!quoteResponse.ok || !summaryResponse.ok) throw new Error(`Nasdaq quote returned HTTP ${quoteResponse.status}/${summaryResponse.status}`);
    const quote = await quoteResponse.json<NasdaqQuotePayload>();
    const summary = await summaryResponse.json<NasdaqQuotePayload>();
    const primary = quote.data?.primaryData;
    const secondary = quote.data?.secondaryData;
    const marketStatus = primary?.marketStatus?.toLowerCase() ?? "";
    const isPreMarket = marketStatus.includes("pre");
    const primaryPrice = Number(primary?.lastSalePrice?.replace(/[$,]/g, ""));
    const secondaryPrice = Number(secondary?.lastSalePrice?.replace(/[$,]/g, ""));
    const secondaryChange = Number(secondary?.percentageChange?.replace(/[+%]/g, ""));
    const summaryPreviousClose = Number(summary.data?.summaryData?.PreviousClose?.value?.replace(/[$,]/g, ""));
    const fromDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const toDate = new Date().toISOString().slice(0, 10);
    const historyResponse = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=stocks&fromdate=${fromDate}&todate=${toDate}&limit=30`, { headers });
    if (!historyResponse.ok) throw new Error(`Nasdaq history returned HTTP ${historyResponse.status}`);
    const history = await historyResponse.json<NasdaqHistoryPayload>();
    const historicalVolumes = (history.data?.tradesTable?.rows ?? []).map((row) => Number(row.volume?.replace(/[,]/g, ""))).filter((value) => Number.isFinite(value) && value > 0);
    const average30DayVolume = historicalVolumes.slice(1).reduce((sum, value) => sum + value, 0) / Math.max(historicalVolumes.length - 1, 1);
    // 盘前 primaryData 代表即时撮合价，secondaryData 代表最近完整交易日收盘。
    // 异动雷达需要比较完整交易日的收盘涨跌幅，避免把盘前报价和错误前收混算。
    const currentPrice = isPreMarket && Number.isFinite(secondaryPrice) && secondaryPrice > 0 ? secondaryPrice : primaryPrice;
    const previousClose = isPreMarket && Number.isFinite(secondaryChange) && secondaryChange !== -100
      ? currentPrice / (1 + secondaryChange / 100)
      : summaryPreviousClose;
    const currentVolume = isPreMarket ? Number(historicalVolumes[0]) : Number(primary?.volume?.replace(/[,]/g, ""));
    if (!Number.isFinite(currentPrice) || !Number.isFinite(previousClose) || previousClose <= 0 || !Number.isFinite(currentVolume) || !Number.isFinite(average30DayVolume) || average30DayVolume <= 0) throw new Error("Nasdaq quote payload was incomplete");
    const session = marketStatus.includes("pre") ? "pre" : marketStatus.includes("after") || marketStatus.includes("post") ? "after" : "regular";
    return { symbol, market: "US", session, price: currentPrice, previousClose, volume: currentVolume, average30DayVolume };
  } catch (error) {
    console.warn(`[Quote] ${symbol} Nasdaq 实时行情获取失败。`, error);
    return null;
  }
}

function mergeNewsResults(results: NewsFetchResult[]) {
  const seen = new Set<string>();
  const items = results.flatMap((result) => result.items).filter((item) => {
    const key = item.title.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
  return { items, context: buildNewsContext(items), sourceErrors: results.flatMap((result) => result.sourceErrors) };
}

async function fetchMacroSummary(env: Env, config: IndexConfig, now: string, blockedPeople: string[]): Promise<MacroSummary> {
  console.log(`[Macro] 开始生成 ${config.market} 大盘兜底摘要。`);
  const snapshot = await fetchIndexSnapshot(config);
  const baseInput = {
    market: config.market,
    indexName: config.indexName,
    changePercent: snapshot.changePercent,
    newsContext: "",
    blockedPeople,
    now,
    dataTimestamp: snapshot.observedAt,
  } as const;
  if (snapshot.failed) {
    const summary = createMacroErrorSummary(baseInput, "market_data_unavailable");
    await env.WHY_DATA.put(`MARKET_SUMMARY_${config.market}`, JSON.stringify(summary));
    return summary;
  }
  const tickers = [config.newsTicker ?? config.ticker, config.supportingTicker].filter((ticker): ticker is string => Boolean(ticker));
  const macroCalendarQuery = config.market === "US"
    ? "US stock market upcoming CPI FOMC economic data earnings calendar"
    : "Hong Kong stock market upcoming economic data earnings calendar";
  const news = mergeNewsResults(await Promise.all([
    ...tickers.map((ticker) => fetchRecentNews(ticker, {
      now: Date.parse(now), finnhubApiKey: env.FINNHUB_API_KEY, blockedPeople,
    })),
    // 为 next_catalyst 补充可验证的日历型资讯，不能仅靠指数/ETF 标题猜测。
    fetchRecentNews(config.newsTicker ?? config.ticker, {
      now: Date.parse(now), blockedPeople, googleSearchQuery: macroCalendarQuery,
    }),
  ]));
  if (news.sourceErrors.length) console.warn(`[Macro] ${config.market} 部分新闻源失败`, news.sourceErrors);

  const input = {
    ...baseInput,
    newsContext: news.context,
  } as const;
  const summary = news.items.length === 0
    ? createMacroErrorSummary(input, "news_unavailable")
    : env.DEEPSEEK_API_KEY
      ? await generateDeepSeekMacroSummary(env.DEEPSEEK_API_KEY, input)
      : createMacroErrorSummary(input, "deepseek_unavailable");

  await env.WHY_DATA.put(`MARKET_SUMMARY_${config.market}`, JSON.stringify(summary));
  console.log(`[Success] MARKET_SUMMARY_${config.market} KV 写入成功，基准 ${snapshot.ticker} ${summary.change_percent}。`);
  return summary;
}

async function runRadarSweep(env: Env): Promise<TriggeredAlert[]> {
  console.log("[Cron] 开始巡检美股池与港股池...");
  const hotTickers = (env.HOT_TICKERS ?? "").split(",").map((ticker) => ticker.trim().toUpperCase()).filter(Boolean);
  const blockedPeople = (env.BLOCKED_PERSONS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  const usWatchlist = [...hotTickers, ...MARKET_RULES.US.watchlist];
  const quotes = env.MARKET_DATA_MODE === "live"
    ? (await Promise.all(usWatchlist.map(fetchLiveUsQuote))).filter((quote): quote is MarketQuote => Boolean(quote))
    : createMockQuotes(usWatchlist[0], env.MOCK_SCENARIO ?? "alert");
  const now = new Date().toISOString();
  const alerts: TriggeredAlert[] = [];

  for (const quote of quotes.filter((item) => shouldTrigger(item, item.market === "US" ? usWatchlist : undefined))) {
    try {
      const changePercent = getChangePercent(quote);
      console.log(`[Alert] ${quote.symbol} 触发异动，开始抓取新闻...`);
      const newsResult = await fetchRecentNews(quote.symbol, { finnhubApiKey: env.FINNHUB_API_KEY, blockedPeople });
      if (newsResult.sourceErrors.length) console.warn(`[News] ${quote.symbol} 部分新闻源失败`, newsResult.sourceErrors);
      console.log(`[News] ${quote.symbol} 获取 ${newsResult.items.length} 条有效新闻。`);
      const ai = env.DEEPSEEK_API_KEY
        ? await generateDeepSeekAlert(env.DEEPSEEK_API_KEY, { symbol: quote.symbol, market: quote.market, changePercent, news: newsResult.items, newsContext: newsResult.context, blockedPeople, now })
        : createFallbackAiAlert(quote.symbol, quote.market, changePercent, quote.volume / quote.average30DayVolume, now, newsResult.items.length > 0);
      const alert: TriggeredAlert = {
      id: alertHistorySignature({ market: quote.market, symbol: quote.symbol, session: quote.session, changePercent, triggeredAt: now }),
      symbol: quote.symbol,
      market: quote.market,
      session: quote.session,
      price: quote.price,
      previousClose: quote.previousClose,
      changePercent,
      volumeRatio: quote.volume / quote.average30DayVolume,
      triggeredAt: now,
      ai,
        news: newsResult.items,
      };

      const key = `STOCK_${quote.market}_${quote.symbol}`;
      const historyKey = `${key}_HISTORY`;
      const existingHistory = (await env.WHY_DATA.get<TriggeredAlert[]>(historyKey, "json")) ?? [];
      const history = [alert, ...existingHistory].filter((item, index, all) => {
        const signature = alertHistorySignature(item);
        return all.findIndex((candidate) => alertHistorySignature(candidate) === signature) === index;
      }).slice(0, 20);

      await Promise.all([
        env.WHY_DATA.put(key, JSON.stringify(alert)),
        env.WHY_DATA.put(historyKey, JSON.stringify(history)),
      ]);
      console.log(`[Success] ${key} KV 写入成功。`);
      alerts.push(alert);
    } catch (error) {
      console.error(`[Error] ${quote.symbol} 异动处理失败，已跳过该标的。`, error);
    }
  }

  if (alerts.length === 0) {
    console.log("[Macro] 本轮无个股异动，启动大盘情绪兜底。");
    await Promise.all(MACRO_INDICES.map((config) => fetchMacroSummary(env, config, now, blockedPeople).catch((error) => {
      console.error(`[Macro] ${config.market} 大盘摘要生成失败。`, error);
    })));
  } else {
    await Promise.all(MACRO_INDICES.map((config) => env.WHY_DATA.delete(`MARKET_SUMMARY_${config.market}`)));
  }

  await env.WHY_DATA.put("LATEST_ALERTS", JSON.stringify(alerts));
  console.log(`[Cron] 巡检完成，本轮写入 ${alerts.length} 条异动。`);
  return alerts;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/latest") {
      const alerts = (await env.WHY_DATA.get<TriggeredAlert[]>("LATEST_ALERTS", "json")) ?? [];
      const macroSummaries = alerts.length === 0
        ? (await Promise.all(MACRO_INDICES.map((config) => env.WHY_DATA.get<MacroSummary>(`MARKET_SUMMARY_${config.market}`, "json")))).filter((summary): summary is MacroSummary => Boolean(summary))
        : [];
      return json({
        alerts: alerts.map(toPublicAlert),
        macroSummaries: macroSummaries.map(toPublicMacroSummary),
        generatedAt: new Date().toISOString(),
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/alert/")) {
      const symbol = decodeURIComponent(url.pathname.replace("/api/alert/", "")).toUpperCase();
      if (!/^[A-Z0-9.=-]{1,16}$/.test(symbol)) return json({ error: "Invalid symbol" }, 400);
      for (const market of ["US", "HK"] as const) {
        const alert = await env.WHY_DATA.get<TriggeredAlert>(`STOCK_${market}_${symbol}`, "json");
        if (alert) return json({ alert: toPublicAlert(alert) });
      }
      return json({ error: "Alert not found" }, 404);
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/history/")) {
      const [market, symbol] = url.pathname.replace("/api/history/", "").split("/");
      if (!market || !symbol) return json({ error: "Expected /api/history/:market/:symbol" }, 400);
      const history = (await env.WHY_DATA.get<TriggeredAlert[]>(`STOCK_${market.toUpperCase()}_${symbol.toUpperCase()}_HISTORY`, "json")) ?? [];
      return json({ history: history.map(toPublicAlert) });
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runRadarSweep(env).catch((error) => console.error("[Cron] 巡检任务异常结束。", error)));
  },
} satisfies ExportedHandler<Env>;

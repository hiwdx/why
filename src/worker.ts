import { createFallbackMacroSummary, generateDeepSeekAlert, generateDeepSeekMacroSummary, type MacroSummary } from "../lib/deepseek";
import { buildNewsContext, fetchRecentNews, type NewsFetchResult } from "../lib/news";
import { MARKET_RULES } from "../config/rules";
import { createFallbackAiAlert, createMockQuotes, getChangePercent, shouldTrigger, type TriggeredAlert } from "./domain/radar";

export interface Env {
  WHY_DATA: KVNamespace;
  DEEPSEEK_API_KEY?: string;
  FINNHUB_API_KEY?: string;
  MARKET_DATA_MODE?: "mock" | "live";
  HOT_TICKERS?: string;
  BLOCKED_PERSONS?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function toPublicAlert(alert: TriggeredAlert): TriggeredAlert {
  return { ...alert, ai: { ...alert.ai, raw_response: undefined } };
}

type MacroMarket = "US" | "HK";
type IndexConfig = { market: MacroMarket; ticker: string; supportingTicker?: string; indexName: string; fallbackChangePercent: number };
type IndexSnapshot = { changePercent: number; ticker: string };

const MACRO_INDICES: IndexConfig[] = [
  { market: "US", ticker: "SPY", supportingTicker: "QQQ", indexName: "S&P 500", fallbackChangePercent: 0.15 },
  { market: "HK", ticker: "^HSI", indexName: "恒生指数", fallbackChangePercent: -0.1 },
];

async function fetchIndexSnapshot(config: IndexConfig): Promise<IndexSnapshot> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(config.ticker)}?range=5d&interval=1d`;
  try {
    const response = await fetch(url, { headers: { "user-agent": "why.hiwd.com macro radar/1.0", accept: "application/json" } });
    if (!response.ok) throw new Error(`Yahoo index quote returned HTTP ${response.status}`);
    const payload = await response.json<{ chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number; chartPreviousClose?: number } }> } }>();
    const meta = payload.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    const previousClose = Number(meta?.chartPreviousClose ?? meta?.previousClose);
    if (!Number.isFinite(price) || !Number.isFinite(previousClose) || previousClose <= 0) throw new Error("Yahoo index quote payload was incomplete");
    return { ticker: config.ticker, changePercent: ((price - previousClose) / previousClose) * 100 };
  } catch (error) {
    console.warn(`[Macro] ${config.ticker} 行情读取失败，使用保守兜底。`, error);
    return { ticker: config.ticker, changePercent: config.fallbackChangePercent };
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
  const tickers = [config.ticker, config.supportingTicker].filter((ticker): ticker is string => Boolean(ticker));
  const news = mergeNewsResults(await Promise.all(tickers.map((ticker) => fetchRecentNews(ticker, {
    now: Date.parse(now), finnhubApiKey: env.FINNHUB_API_KEY, blockedPeople,
  }))));
  if (news.sourceErrors.length) console.warn(`[Macro] ${config.market} 部分新闻源失败`, news.sourceErrors);

  const input = {
    market: config.market,
    indexName: config.indexName,
    changePercent: snapshot.changePercent,
    newsContext: news.context,
    blockedPeople,
    now,
  } as const;
  const summary = env.DEEPSEEK_API_KEY
    ? await generateDeepSeekMacroSummary(env.DEEPSEEK_API_KEY, input)
    : createFallbackMacroSummary(input);

  await env.WHY_DATA.put(`MARKET_SUMMARY_${config.market}`, JSON.stringify(summary));
  console.log(`[Success] MARKET_SUMMARY_${config.market} KV 写入成功，基准 ${snapshot.ticker} ${summary.change_percent}。`);
  return summary;
}

async function runRadarSweep(env: Env): Promise<TriggeredAlert[]> {
  console.log("[Cron] 开始巡检美股池与港股池...");
  // 下一阶段在此替换为 Yahoo Finance 或付费行情源。MVP 固定使用可重放的测试行情。
  const hotTickers = (env.HOT_TICKERS ?? "").split(",").map((ticker) => ticker.trim().toUpperCase()).filter(Boolean);
  const blockedPeople = (env.BLOCKED_PERSONS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  const usWatchlist = [...hotTickers, ...MARKET_RULES.US.watchlist];
  const quotes = createMockQuotes(usWatchlist[0]);
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
      id: `${quote.market}_${quote.symbol}_${now}`,
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
      const history = [alert, ...existingHistory.filter((item) => item.id !== alert.id)].slice(0, 20);

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
      return json({ alerts: alerts.map(toPublicAlert), macroSummaries, generatedAt: new Date().toISOString() });
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

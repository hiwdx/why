import type { NewsContext } from "./deepseek";
import { shouldHideRestrictedContent } from "./content-safety";

const NEWS_WINDOW_MS = 48 * 60 * 60 * 1000;
// 以 CJK 文本的最保守情况限长，保证远低于 2,000 token 的 DeepSeek Context 预算。
const MAX_CONTEXT_CHARS = 1800;

export type NewsFetchResult = {
  items: NewsContext[];
  context: string;
  sourceErrors: string[];
};

type RssSource = { name: string; url: string };
type FinnhubArticle = { headline?: string; source?: string; datetime?: number; url?: string; summary?: string };

const decodeHtml = (value: string) => value
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">");

export function cleanNewsText(value: string): string {
  return decodeHtml(value)
    .replace(/<!\[CDATA\[|\]\]>/g, " ")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b(?:advertisement|sponsored|read more|click here)\b/gi, " ")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTag(item: string, tag: string): string {
  const match = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return cleanNewsText(match?.[1] ?? "");
}

export function parseRss(xml: string, fallbackSource: string): NewsContext[] {
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  return items.map((item) => ({
    title: getTag(item, "title"),
    source: getTag(item, "source") || fallbackSource,
    publishedAt: getTag(item, "pubDate") || getTag(item, "dc:date"),
    url: getTag(item, "link"),
    description: getTag(item, "description"),
  })).filter((item) => item.title.length > 0);
}

async function fetchRss(source: RssSource): Promise<NewsContext[]> {
  const response = await fetch(source.url, {
    headers: { "user-agent": "why.hiwd.com news context builder/1.0", accept: "application/rss+xml, application/xml, text/xml" },
  });
  if (!response.ok) throw new Error(`${source.name} returned HTTP ${response.status}`);
  return parseRss(await response.text(), source.name);
}

async function fetchFinnhub(symbol: string, apiKey: string, now: number): Promise<NewsContext[]> {
  const from = new Date(now - NEWS_WINDOW_MS).toISOString().slice(0, 10);
  const to = new Date(now).toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Finnhub returned HTTP ${response.status}`);
  const articles = await response.json<FinnhubArticle[]>();
  if (!Array.isArray(articles)) throw new Error("Finnhub returned an invalid payload");

  return articles.map((article) => ({
    title: cleanNewsText(article.headline ?? ""),
    source: cleanNewsText(article.source ?? "Finnhub"),
    publishedAt: typeof article.datetime === "number" ? new Date(article.datetime * 1000).toISOString() : "",
    url: article.url,
    description: cleanNewsText(article.summary ?? ""),
  })).filter((article) => article.title.length > 0);
}

function isRecent(item: NewsContext, now: number): boolean {
  const publishedAt = Date.parse(item.publishedAt);
  return Number.isFinite(publishedAt) && publishedAt >= now - NEWS_WINDOW_MS && publishedAt <= now + 5 * 60 * 1000;
}

export function buildNewsContext(items: NewsContext[]): string {
  const lines: string[] = [];
  let length = 0;
  for (const item of items) {
    const line = [`[${item.publishedAt}] ${item.source}`, item.title, item.description].filter(Boolean).join("\n");
    if (length + line.length > MAX_CONTEXT_CHARS) break;
    lines.push(line);
    length += line.length;
  }
  return lines.join("\n\n");
}

export async function fetchRecentNews(symbol: string, options: { now?: number; finnhubApiKey?: string; blockedPeople?: readonly string[] } = {}): Promise<NewsFetchResult> {
  const now = options.now ?? Date.now();
  const encodedSymbol = encodeURIComponent(symbol);
  const sources: Array<{ name: string; fetcher: () => Promise<NewsContext[]> }> = [
    ...(options.finnhubApiKey ? [{ name: "Finnhub", fetcher: () => fetchFinnhub(symbol, options.finnhubApiKey!, now) }] : []),
    { name: "Yahoo Finance RSS", fetcher: () => fetchRss({ name: "Yahoo Finance RSS", url: `https://finance.yahoo.com/rss/headline?s=${encodedSymbol}` }) },
    // Yahoo 的免费 RSS 偶尔会在边缘节点返回 429；Google News RSS 作为独立的免费冗余源。
    {
      name: "Google News RSS",
      fetcher: () => fetchRss({
        name: "Google News RSS",
        url: `https://news.google.com/rss/search?q=${encodeURIComponent(`${symbol} stock market`)}&hl=en-US&gl=US&ceid=US:en`,
      }),
    },
  ];
  const settled = await Promise.allSettled(sources.map((source) => source.fetcher()));
  const sourceErrors = settled.flatMap((result, index) => result.status === "rejected" ? [`${sources[index].name}: ${String(result.reason)}`] : []);
  const seen = new Set<string>();
  const items = settled.flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .filter((item) => isRecent(item, now))
    .filter((item) => !shouldHideRestrictedContent(`${item.title}\n${item.description ?? ""}`, options.blockedPeople))
    .filter((item) => {
      const key = item.title.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, 8);

  return { items, context: buildNewsContext(items), sourceErrors };
}

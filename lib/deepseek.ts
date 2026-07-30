import OpenAI from "openai";
import { shouldHideRestrictedContent } from "./content-safety";

export type NewsContext = {
  title: string;
  source: string;
  publishedAt: string;
  url?: string;
  description?: string;
};

export type DeepSeekAlert = {
  stock_symbol: string;
  market: "US" | "HK";
  change_percent: string;
  why_one_liner: string;
  key_factors: string[];
  timestamp: string;
  error?: string;
  raw_response?: string;
};

export type SummarizeInput = {
  symbol: string;
  market: "US" | "HK";
  changePercent: number;
  news: NewsContext[];
  newsContext: string;
  blockedPeople?: readonly string[];
  now: string;
};

const systemPrompt = `你是 why.hiwd.com 的金融信息编辑。只根据新闻 Context 解释已触发的股票异动。
不要编造因果关系。若新闻 Context 为空，why_one_liner 必须严格为“未检测到明显的新闻事件催化，可能为技术面调整或资金博弈。”，key_factors 必须说明资讯为空。
不得输出中国国家、政府或军队领导人信息，也不得输出敏感人物信息。涉及此类内容时必须视为没有可用新闻 Context，并使用规定的无新闻兜底文案。
只返回合法 JSON 对象，不得使用 Markdown 代码块或输出额外文字。`;

function errorAlert(input: SummarizeInput, error: string, raw = ""): DeepSeekAlert {
  return {
    stock_symbol: input.symbol,
    market: input.market,
    change_percent: `${input.changePercent > 0 ? "+" : ""}${input.changePercent.toFixed(1)}%`,
    why_one_liner: "未能完成自动归因，请查看原始行情与后续资讯。",
    key_factors: ["模型输出解析失败，已保留结构化错误状态。"],
    timestamp: input.now,
    error,
    raw_response: raw.slice(0, 1200),
  };
}

function parseAlert(content: string | null, input: SummarizeInput): DeepSeekAlert {
  if (!content) return errorAlert(input, "解析失败：模型返回为空");

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const extracted = content.match(/\{[\s\S]*\}/)?.[0];
    if (!extracted) return errorAlert(input, "解析失败：未找到 JSON 对象", content);
    try {
      parsed = JSON.parse(extracted);
    } catch {
      return errorAlert(input, "解析失败：JSON 对象无效", content);
    }
  }
  if (!parsed || typeof parsed !== "object") return errorAlert(input, "解析失败：输出不是 JSON 对象", content);

  const value = parsed as Partial<DeepSeekAlert>;
  if (
    typeof value.why_one_liner !== "string" ||
    !Array.isArray(value.key_factors) ||
    !value.key_factors.every((factor) => typeof factor === "string")
  ) {
    return errorAlert(input, "解析失败：JSON 字段不完整", content);
  }
  if (shouldHideRestrictedContent(`${value.why_one_liner}\n${value.key_factors.join("\n")}`, input.blockedPeople)) {
    return errorAlert(input, "内容过滤：模型输出包含受限政治内容");
  }

  return {
    stock_symbol: input.symbol,
    market: input.market,
    change_percent: `${input.changePercent > 0 ? "+" : ""}${input.changePercent.toFixed(1)}%`,
    why_one_liner: value.why_one_liner,
    key_factors: value.key_factors.slice(0, 2),
    timestamp: input.now,
  };
}

export async function generateDeepSeekAlert(apiKey: string, input: SummarizeInput): Promise<DeepSeekAlert> {
  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.deepseek.com",
  });

  try {
    const response = await client.chat.completions.create({
    model: "deepseek-chat",
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: JSON.stringify({
          task: "请生成以下 JSON 结构，不可增加字段：",
          schema: {
            stock_symbol: input.symbol,
            market: input.market,
            change_percent: `${input.changePercent > 0 ? "+" : ""}${input.changePercent.toFixed(1)}%`,
            why_one_liner: "一句话核心原因",
            key_factors: ["因素1", "因素2"],
            timestamp: input.now,
          },
          news_context_last_48h: input.newsContext,
          news_items_count: input.news.length,
        }),
      },
    ],
    });

    return parseAlert(response.choices[0]?.message.content, input);
  } catch (error) {
    return errorAlert(input, `DeepSeek 请求失败：${error instanceof Error ? error.message : "unknown error"}`);
  }
}

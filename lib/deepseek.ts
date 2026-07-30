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

export type MacroSummary = {
  type: "macro_summary";
  market: "US" | "HK";
  index_name: string;
  change_percent: string;
  status_label: string;
  macro_reason: string;
  next_catalyst: string;
  timestamp: string;
  error?: "market_data_unavailable" | "news_unavailable" | "deepseek_unavailable" | "invalid_model_output" | "restricted_content";
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

export type MacroSummaryInput = {
  market: "US" | "HK";
  indexName: string;
  changePercent: number;
  newsContext: string;
  blockedPeople?: readonly string[];
  now: string;
};

const systemPrompt = `你是 why.hiwd.com 的金融信息编辑。只根据新闻 Context 解释已触发的股票异动。
不要编造因果关系。若新闻 Context 为空，why_one_liner 必须严格为“未检测到明显的新闻事件催化，可能为技术面调整或资金博弈。”，key_factors 必须说明资讯为空。
不得输出中国国家、政府或军队领导人信息，也不得输出敏感人物信息。涉及此类内容时必须视为没有可用新闻 Context，并使用规定的无新闻兜底文案。
只返回合法 JSON 对象，不得使用 Markdown 代码块或输出额外文字。`;

const macroSystemPrompt = `你是 why.hiwd.com 的市场编辑。当个股没有触发显著异动时，只根据传入的指数行情和新闻 Context，解释大盘当日表现。
你必须严格使用传入的 status_label，不得改写、弱化或把大幅涨跌称为盘整。
macro_reason 必须提取新闻 Context 中的具体事件、数据或行业变化，并说明其与当日指数表现的关系。禁止输出“未检测到明显事件”“常规交易节奏”“资金博弈”等空泛模板。
next_catalyst 必须提取新闻 Context 中明确、即将发生的事件或日期。禁止使用“关注后续”“重要数据”等模糊词。
如果 Context 无法支持具体原因或催化剂，返回 error 字段为 "news_unavailable"，且 macro_reason 与 next_catalyst 均严格为“[信源获取失败，请稍后重试]”。
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

export function macroStatusLabel(changePercent: number): string {
  const absoluteChange = Math.abs(changePercent);
  if (absoluteChange < 0.5) return "盘整观望";
  if (absoluteChange <= 1.5) return changePercent >= 0 ? "温和走强" : "常规走弱";
  return changePercent >= 0 ? "强势拉升" : "大幅下挫";
}

export function createMacroErrorSummary(
  input: MacroSummaryInput,
  error: NonNullable<MacroSummary["error"]>,
  raw = "",
): MacroSummary {
  return {
    type: "macro_summary",
    market: input.market,
    index_name: input.indexName,
    change_percent: `${input.changePercent > 0 ? "+" : ""}${input.changePercent.toFixed(2)}%`,
    status_label: macroStatusLabel(input.changePercent),
    macro_reason: "[信源获取失败，请稍后重试]",
    next_catalyst: "[信源获取失败，请稍后重试]",
    timestamp: input.now,
    error,
    raw_response: raw.slice(0, 1200),
  };
}

function hasSpecificCatalyst(value: string): boolean {
  // “关注后续/财报/政策信号”无法帮助用户判断下一步；至少要同时给出时间与事件。
  const hasTiming = /(?:\d{1,2}月\d{1,2}日|\d{1,2}[/.\-]\d{1,2}|周[一二三四五六日天]|今晚|明日|本周[一二三四五六日]?|下周[一二三四五六日]?|北京时间\s*\d{1,2}:\d{2})/i.test(value);
  const hasEvent = /(?:CPI|PCE|非农|GDP|FOMC|利率决议|就业数据|通胀数据|财报|业绩|经济数据|央行决议|美联储)/i.test(value);
  return hasTiming && hasEvent;
}

function parseMacroSummary(content: string | null, input: MacroSummaryInput): MacroSummary {
  if (!content) return createMacroErrorSummary(input, "invalid_model_output");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const extracted = content.match(/\{[\s\S]*\}/)?.[0];
    if (!extracted) return createMacroErrorSummary(input, "invalid_model_output", content);
    try {
      parsed = JSON.parse(extracted);
    } catch {
      return createMacroErrorSummary(input, "invalid_model_output", content);
    }
  }
  if (!parsed || typeof parsed !== "object") return createMacroErrorSummary(input, "invalid_model_output", content);

  const value = parsed as Partial<MacroSummary>;
  if (value.error === "news_unavailable") return createMacroErrorSummary(input, "news_unavailable", content);
  if (typeof value.macro_reason !== "string" || typeof value.next_catalyst !== "string") {
    return createMacroErrorSummary(input, "invalid_model_output", content);
  }
  if (!hasSpecificCatalyst(value.next_catalyst)) {
    return createMacroErrorSummary(input, "invalid_model_output", content);
  }
  if (shouldHideRestrictedContent(`${value.macro_reason}\n${value.next_catalyst}`, input.blockedPeople)) {
    return createMacroErrorSummary(input, "restricted_content", content);
  }

  return {
    type: "macro_summary",
    market: input.market,
    index_name: input.indexName,
    change_percent: `${input.changePercent > 0 ? "+" : ""}${input.changePercent.toFixed(2)}%`,
    status_label: macroStatusLabel(input.changePercent),
    macro_reason: value.macro_reason,
    next_catalyst: value.next_catalyst,
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

export async function generateDeepSeekMacroSummary(apiKey: string, input: MacroSummaryInput): Promise<MacroSummary> {
  const client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" });
  try {
    const response = await client.chat.completions.create({
      model: "deepseek-chat",
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        { role: "system", content: macroSystemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            task: "请生成以下 JSON 结构，不可增加字段：",
            schema: {
              type: "macro_summary",
              market: input.market,
              index_name: input.indexName,
              change_percent: `${input.changePercent > 0 ? "+" : ""}${input.changePercent.toFixed(2)}%`,
              status_label: macroStatusLabel(input.changePercent),
              macro_reason: "从新闻 Context 提取的具体宏观原因",
              next_catalyst: "从新闻 Context 提取的明确待发生事件",
              timestamp: input.now,
            },
            market_news_context_last_48h: input.newsContext,
          }),
        },
      ],
    });
    return parseMacroSummary(response.choices[0]?.message.content, input);
  } catch (error) {
    return createMacroErrorSummary(input, "deepseek_unavailable", error instanceof Error ? error.message : "unknown error");
  }
}

import { useEffect, useMemo, useState } from "react";
import { shouldHideRestrictedContent } from "../lib/content-safety";
import type { TriggeredAlert } from "./domain/radar";

type LatestResponse = { alerts: TriggeredAlert[] };
type AlertResponse = { alert?: TriggeredAlert };
type HistoryResponse = { history: TriggeredAlert[] };
type Status = "loading" | "ready" | "empty" | "error";

const sessionLabel = { pre: "盘前", regular: "盘中", after: "盘后" };

function symbolFromPath() {
  const querySymbol = new URLSearchParams(window.location.search).get("symbol");
  if (querySymbol) return querySymbol.toUpperCase();
  const baseSegments = import.meta.env.BASE_URL.split("/").filter(Boolean);
  const pathSegments = window.location.pathname.split("/").filter(Boolean);
  const segment = pathSegments.slice(baseSegments.length)[0];
  return segment ? decodeURIComponent(segment).toUpperCase() : null;
}

function formatTime(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function displayedReason(alert: TriggeredAlert) {
  const hidden = shouldHideRestrictedContent(`${alert.ai.why_one_liner}\n${alert.ai.key_factors.join("\n")}`);
  return alert.ai.error || hidden ? "当前资讯不足，暂不展示原因。" : alert.ai.why_one_liner;
}

export function App() {
  const symbol = useMemo(symbolFromPath, []);
  const [status, setStatus] = useState<Status>("loading");
  const [alert, setAlert] = useState<TriggeredAlert | null>(null);
  const [history, setHistory] = useState<TriggeredAlert[]>([]);

  useEffect(() => {
    async function load() {
      try {
        const response = symbol
          ? await fetch(`/api/alert/${encodeURIComponent(symbol)}`)
          : await fetch("/api/latest");
        if (response.status === 404) return setStatus("empty");
        if (!response.ok) throw new Error("Unable to load alert data");
        const nextAlert = symbol
          ? ((await response.json() as AlertResponse).alert ?? null)
          : ((await response.json() as LatestResponse).alerts[0] ?? null);
        if (!nextAlert) return setStatus("empty");

        setAlert(nextAlert);
        const historyResponse = await fetch(`/api/history/${nextAlert.market}/${encodeURIComponent(nextAlert.symbol)}`);
        if (historyResponse.ok) {
          setHistory((await historyResponse.json() as HistoryResponse).history);
        } else {
          setHistory([nextAlert]);
        }
        setStatus("ready");
      } catch {
        setStatus("error");
      }
    }
    void load();
  }, [symbol]);

  return (
    <main className="flex min-h-[100dvh] overflow-x-hidden bg-[#101110] px-4 py-4 text-[#f3f5f1] selection:bg-[#00c2b3]/30 sm:px-6 sm:py-6">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-white/10 pb-4">
          <a href={import.meta.env.BASE_URL} aria-label="why.hiwd.com 首页" className="text-xl font-medium tracking-[-0.04em] text-white">why<span className="text-[#00c2b3]">.</span></a>
          <span className="text-sm text-white/55">解释股票异动</span>
        </header>

        <section className="max-w-2xl py-10 sm:py-14">
          <p className="text-sm text-[#62ddd4]">{symbol ? "标的异动档案" : "今日重点异动"}</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.055em] text-white sm:text-5xl">先看原因，再看价格。</h1>
          <p className="mt-4 max-w-lg text-sm leading-6 text-white/50">把价格、成交与资讯压成一张能快速读完的卡。</p>
        </section>

        {status === "loading" && <SkeletonDashboard />}
        {status === "empty" && <EmptyState symbol={symbol} />}
        {status === "error" && <ErrorState />}
        {status === "ready" && alert && <Dashboard alert={alert} history={history.length ? history : [alert]} />}

        <footer className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-white/10 pt-4 text-xs text-white/45">
          <span>© 2026 hiwd</span>
          <span>内容仅作信息整理，不构成投资建议。</span>
        </footer>
      </div>
    </main>
  );
}

function Dashboard({ alert, history }: { alert: TriggeredAlert; history: TriggeredAlert[] }) {
  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.65fr)] lg:gap-5"><WhyCard alert={alert} /><Timeline symbol={alert.symbol} history={history} /></div>;
}

function WhyCard({ alert }: { alert: TriggeredAlert }) {
  const [copied, setCopied] = useState(false);
  const isUp = alert.changePercent > 0;
  const reason = displayedReason(alert);
  const hidden = reason === "当前资讯不足，暂不展示原因。";
  const factors = hidden ? [reason] : alert.ai.key_factors;
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const link = `${window.location.origin}${basePath}/${encodeURIComponent(alert.symbol)}`;
  const shareText = `【${alert.symbol}】${isUp ? "上涨" : "下跌"} ${Math.abs(alert.changePercent).toFixed(1)}%\n原因：${reason}\n详情：${link}`;

  async function copyShareText() {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  const movementClass = isUp ? "border-rose-300/25 bg-rose-300/10 text-rose-200" : "border-emerald-300/25 bg-emerald-300/10 text-emerald-200";
  return (
    <article className="border border-white/10 bg-[#151715] p-5 sm:p-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-3xl font-semibold tracking-[-0.05em] text-white">{alert.symbol}</h2>
            <span className="border border-white/10 px-2 py-1 font-mono text-[11px] text-white/50">{alert.market} / {sessionLabel[alert.session]}</span>
          </div>
          <p className="mt-2 font-mono text-xs text-white/40">触发于 {formatTime(alert.triggeredAt)}</p>
        </div>
        <div className={`border px-3 py-2 text-right font-mono ${movementClass}`}>
          <p className="text-xl font-semibold tracking-[-0.05em]">{alert.ai.change_percent}</p>
          <p className="mt-0.5 text-xs text-white/45">${alert.price.toFixed(2)}</p>
        </div>
      </div>

      <div className="mt-9 border-l-2 border-[#00c2b3] pl-4 sm:pl-5">
        <p className="font-mono text-[11px] tracking-[0.14em] text-[#62ddd4]">原因</p>
        <p className="mt-3 text-2xl font-semibold leading-tight tracking-[-0.04em] text-white sm:text-3xl">{reason}</p>
      </div>

      <ul className="mt-8 space-y-3 border-t border-white/10 pt-6">
        {factors.map((factor) => <li key={factor} className="grid grid-cols-[8px_1fr] gap-3 text-sm leading-6 text-white/70"><span className="mt-2 size-1.5 rounded-full bg-[#00c2b3]" />{factor}</li>)}
      </ul>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-5">
        <dl className="flex gap-5 font-mono text-xs">
          <div><dt className="text-white/35">昨收</dt><dd className="mt-1 text-white/75">${alert.previousClose.toFixed(2)}</dd></div>
          <div><dt className="text-white/35">量比</dt><dd className="mt-1 text-white/75">{alert.volumeRatio.toFixed(2)}×</dd></div>
        </dl>
        <button type="button" onClick={copyShareText} className="border border-[#00c2b3] bg-[#00c2b3] px-3 py-2 text-sm font-medium text-[#0d1110] transition hover:bg-[#62ddd4] active:scale-[0.98]">{copied ? "已复制" : "复制分享文案"}</button>
      </div>
    </article>
  );
}

function Timeline({ symbol, history }: { symbol: string; history: TriggeredAlert[] }) {
  return (
    <aside className="border border-white/10 bg-[#151715] p-5 sm:p-6">
      <h2 className="text-lg font-semibold tracking-[-0.03em] text-white">{symbol} 时间线</h2>
      <p className="mt-1 text-sm text-white/45">把单次波动放回连续语境。</p>
      <ol className="mt-7">
        {history.map((event, index) => {
          const isUp = event.changePercent > 0;
          return <li key={event.id} className="relative grid grid-cols-[18px_1fr] gap-3 pb-7 last:pb-0">
            <span className={`relative z-10 mt-1.5 size-2.5 border-2 border-[#151715] ${isUp ? "bg-rose-300" : "bg-emerald-300"}`} />
            {index !== history.length - 1 && <span className="absolute bottom-0 left-[5px] top-5 w-px bg-white/15" />}
            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <time className="font-mono text-[11px] text-white/40">{formatTime(event.triggeredAt)} / {sessionLabel[event.session]}</time>
                <b className={`font-mono text-sm ${isUp ? "text-rose-200" : "text-emerald-200"}`}>{event.ai.change_percent}</b>
              </div>
              <p className="mt-2 text-sm leading-6 text-white/70">{displayedReason(event)}</p>
            </div>
          </li>;
        })}
      </ol>
    </aside>
  );
}

function SkeletonDashboard() {
  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.65fr)] lg:gap-5"><div className="h-[390px] animate-pulse border border-white/10 bg-[#151715] p-6 motion-reduce:animate-none"><div className="h-8 w-32 bg-white/10" /><div className="mt-12 h-24 bg-white/[0.07]" /><div className="mt-8 h-14 bg-white/[0.07]" /></div><div className="h-[390px] animate-pulse border border-white/10 bg-[#151715] p-6 motion-reduce:animate-none"><div className="h-6 w-36 bg-white/10" /><div className="mt-12 h-48 bg-white/[0.07]" /></div></div>;
}

function EmptyState({ symbol }: { symbol: string | null }) {
  return <section className="border-y border-white/10 py-16 sm:py-20"><p className="text-sm font-medium text-[#62ddd4]">市场状态</p><h2 className="mt-4 text-2xl font-semibold tracking-[-0.04em] text-white sm:text-3xl">{symbol ? `${symbol} 暂无可展示的异动记录。` : "今日市场平稳，暂无重大异动。"}</h2><p className="mt-4 max-w-md text-sm leading-6 text-white/65">系统持续检查价格、成交量与市值门槛。符合规则的标的会自动出现。</p></section>;
}

function ErrorState() {
  return <section className="border-y border-white/10 py-16"><p className="text-sm font-medium text-[#62ddd4]">市场状态</p><h2 className="mt-4 text-xl font-semibold text-white">暂时无法读取市场信号。</h2><p className="mt-3 text-sm text-white/65">请稍后刷新页面。</p></section>;
}

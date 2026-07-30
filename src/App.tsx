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
        let nextAlert: TriggeredAlert | null;
        if (symbol) {
          const payload = await response.json() as AlertResponse;
          nextAlert = payload.alert ?? null;
        } else {
          const payload = await response.json() as LatestResponse;
          nextAlert = payload.alerts[0] ?? null;
        }
        if (!nextAlert) return setStatus("empty");

        setAlert(nextAlert);
        const historyResponse = await fetch(`/api/history/${nextAlert.market}/${encodeURIComponent(nextAlert.symbol)}`);
        if (historyResponse.ok) {
          const historyPayload = await historyResponse.json() as HistoryResponse;
          setHistory(historyPayload.history);
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
    <main className="min-h-[100dvh] overflow-x-hidden bg-[#08090b] px-4 py-5 text-zinc-100 selection:bg-cyan-300/25 sm:px-6 sm:py-8">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(0,194,179,0.12),transparent_28rem),radial-gradient(circle_at_82%_12%,rgba(190,24,93,0.10),transparent_24rem)]" />
      <div className="relative mx-auto max-w-5xl">
        <header className="flex items-center justify-between border-b border-white/[0.08] pb-5">
          <a href={import.meta.env.BASE_URL} aria-label="why.hiwd.com 首页" className="flex items-center gap-2.5">
            <span className="rounded-md bg-[#00c2b3] px-2 py-1 font-mono text-xs font-semibold text-zinc-950">why</span>
            <span aria-hidden="true" className="h-5 w-px bg-white/[0.14]" />
            <img src={`${import.meta.env.BASE_URL}hiwd-logo-white-green-dot.png`} alt="hiwd" width="52" height="20" className="h-5 w-auto" />
          </a>
          <span className="font-mono text-[11px] tracking-[0.14em] text-zinc-500">MARKET SIGNALS</span>
        </header>

        <section className="py-10 sm:py-14">
          <p className="font-mono text-xs tracking-[0.16em] text-[#62ddd4]">{symbol ? "标的异动档案" : "今日重点异动"}</p>
          <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-[-0.055em] text-white sm:text-5xl">先看原因，再看价格。</h1>
          <p className="mt-4 max-w-lg text-sm leading-6 text-zinc-400">只保留通过价格与成交量规则的结构化结论。</p>
        </section>

        {status === "loading" && <SkeletonDashboard />}
        {status === "empty" && <EmptyState symbol={symbol} />}
        {status === "error" && <ErrorState />}
        {status === "ready" && alert && <Dashboard alert={alert} history={history.length ? history : [alert]} />}

        <footer className="mt-8 text-xs text-zinc-600">内容仅作信息整理，不构成投资建议。</footer>
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
  const hidden = shouldHideRestrictedContent(`${alert.ai.why_one_liner}\n${alert.ai.key_factors.join("\n")}`);
  const reason = alert.ai.error || hidden ? "当前资讯不足，暂不展示原因。" : alert.ai.why_one_liner;
  const factors = hidden ? ["当前资讯不足，暂不展示原因。"] : alert.ai.key_factors;
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

  const movementClass = isUp ? "border-rose-400/25 bg-rose-400/10 text-rose-300" : "border-emerald-400/25 bg-emerald-400/10 text-emerald-300";
  return (
    <article className="rounded-3xl border border-white/[0.12] bg-zinc-950/60 p-5 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-7">
      <div className="flex items-start justify-between gap-4">
        <div><div className="flex items-center gap-2"><h2 className="font-mono text-3xl font-semibold tracking-[-0.05em] text-white">{alert.symbol}</h2><span className="rounded-md border border-white/[0.1] bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-zinc-400">{alert.market} / {sessionLabel[alert.session]}</span></div><p className="mt-2 font-mono text-xs text-zinc-500">触发于 {formatTime(alert.triggeredAt)}</p></div>
        <div className={`rounded-full border px-3 py-1.5 text-right font-mono text-xl font-semibold tracking-[-0.05em] ${movementClass}`}><span>{alert.ai.change_percent}</span><small className="ml-2 text-xs font-medium text-zinc-400">${alert.price.toFixed(2)}</small></div>
      </div>

      <div className="mt-9 border-l-2 border-[#00c2b3] pl-4 sm:pl-5"><p className="font-mono text-[11px] tracking-[0.16em] text-[#62ddd4]">WHY</p><p className="mt-3 text-2xl font-semibold leading-tight tracking-[-0.04em] text-white sm:text-3xl">{reason}</p></div>

      <ul className="mt-8 space-y-3 border-t border-white/[0.08] pt-6">{factors.map((factor) => <li key={factor} className="grid grid-cols-[8px_1fr] gap-3 text-sm leading-6 text-zinc-300"><span className="mt-2 size-1.5 rounded-full bg-[#62ddd4]" />{factor}</li>)}</ul>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-white/[0.08] pt-5"><dl className="flex gap-5 font-mono text-xs"><div><dt className="text-zinc-600">昨收</dt><dd className="mt-1 text-zinc-300">${alert.previousClose.toFixed(2)}</dd></div><div><dt className="text-zinc-600">量比</dt><dd className="mt-1 text-zinc-300">{alert.volumeRatio.toFixed(2)}×</dd></div></dl><button type="button" onClick={copyShareText} className="rounded-full border border-white/[0.14] bg-white/[0.06] px-4 py-2 text-sm font-medium text-white transition active:scale-[0.97] hover:bg-white/[0.1]">{copied ? "已复制" : "复制分享文案"}</button></div>
    </article>
  );
}

function Timeline({ symbol, history }: { symbol: string; history: TriggeredAlert[] }) {
  return <aside className="rounded-3xl border border-white/[0.12] bg-zinc-950/50 p-5 backdrop-blur-xl sm:p-6"><h2 className="text-lg font-semibold tracking-[-0.03em] text-white">{symbol} 时间线</h2><p className="mt-1 text-sm text-zinc-500">把单次波动放回连续语境。</p><ol className="mt-7">{history.map((event, index) => { const isUp = event.changePercent > 0; const hidden = shouldHideRestrictedContent(`${event.ai.why_one_liner}\n${event.ai.key_factors.join("\n")}`); return <li key={event.id} className="relative grid grid-cols-[18px_1fr] gap-3 pb-7 last:pb-0"><span className={`relative z-10 mt-1.5 size-2.5 rounded-full border-2 border-zinc-950 ${isUp ? "bg-rose-400" : "bg-emerald-400"}`} />{index !== history.length - 1 && <span className="absolute bottom-0 left-[5px] top-5 w-px bg-white/[0.12]" />}<div><div className="flex flex-wrap items-baseline justify-between gap-x-3"><time className="font-mono text-[11px] text-zinc-500">{formatTime(event.triggeredAt)} / {sessionLabel[event.session]}</time><b className={`font-mono text-sm ${isUp ? "text-rose-300" : "text-emerald-300"}`}>{event.ai.change_percent}</b></div><p className="mt-2 text-sm leading-6 text-zinc-300">{event.ai.error || hidden ? "当前资讯不足，暂不展示原因。" : event.ai.why_one_liner}</p></div></li>; })}</ol></aside>;
}

function SkeletonDashboard() {
  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.65fr)] lg:gap-5"><div className="h-[390px] animate-pulse rounded-3xl border border-white/[0.08] bg-white/[0.04] p-6"><div className="h-8 w-32 rounded bg-white/[0.08]" /><div className="mt-12 h-24 rounded bg-white/[0.06]" /><div className="mt-8 h-14 rounded bg-white/[0.06]" /></div><div className="h-[390px] animate-pulse rounded-3xl border border-white/[0.08] bg-white/[0.04] p-6"><div className="h-6 w-36 rounded bg-white/[0.08]" /><div className="mt-12 h-48 rounded bg-white/[0.06]" /></div></div>;
}

function EmptyState({ symbol }: { symbol: string | null }) {
  return <section className="rounded-3xl border border-white/[0.12] bg-zinc-950/60 px-6 py-16 text-center backdrop-blur-xl sm:py-20"><p className="font-mono text-xs tracking-[0.16em] text-[#62ddd4]">MARKET STATUS</p><h2 className="mt-4 text-2xl font-semibold tracking-[-0.04em] text-white sm:text-3xl">{symbol ? `${symbol} 暂无可展示的异动记录。` : "今日市场平稳，暂无重大异动。"}</h2><p className="mx-auto mt-4 max-w-md text-sm leading-6 text-zinc-500">系统持续检查价格、成交量与市值门槛。符合规则的标的会自动出现。</p></section>;
}

function ErrorState() {
  return <section className="rounded-3xl border border-white/[0.12] bg-zinc-950/60 px-6 py-16 text-center backdrop-blur-xl"><h2 className="text-xl font-semibold text-white">暂时无法读取市场信号。</h2><p className="mt-3 text-sm text-zinc-500">请稍后刷新页面。</p></section>;
}

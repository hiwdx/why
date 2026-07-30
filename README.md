# why.hiwd.com

用结构化卡片解释美股和港股的价格异动。前端为 Cloudflare Pages 静态站点，`/api/*` 和定时扫描由 Cloudflare Worker 提供，二者通过 Workers KV 共享异动数据。

## 架构

```txt
Cron Trigger (每 15 分钟，UTC)
  -> Cloudflare Worker: 取行情、应用规则、取新闻
  -> DeepSeek: 仅输出结构化 JSON
  -> Workers KV: STOCK_<MARKET>_<SYMBOL> / *_HISTORY / LATEST_ALERTS
  -> GET /api/latest
  -> Cloudflare Pages: React 异动卡片与时间线
```

`src/worker.ts` 是 Cron Worker 入口，而非 Pages Function。Cloudflare 的定时触发只会调用 Worker 的 `scheduled()`，因此 API Worker 必须以 `why.hiwd.com/api/*` 路由挂到同一域名；Pages 继续接管其余静态页面请求。

## 首次配置

1. 创建 KV：`npx wrangler kv namespace create WHY_DATA`。
2. 将得到的 `id` 填入 [wrangler.toml](./wrangler.toml) 的 `kv_namespaces` 配置。
3. 配置密钥：`npx wrangler secret put DEEPSEEK_API_KEY` 与 `npx wrangler secret put FINNHUB_API_KEY`。如需补充人物屏蔽名单，使用 `npx wrangler secret put BLOCKED_PERSONS`，值为英文逗号分隔的名称。
4. 部署 Worker：`npm run cf:deploy`。
5. 在 Cloudflare Dashboard 为该 Worker 添加路由 `why.hiwd.com/api/*`。
6. 构建并部署 Pages：`npm run build` 后执行 `npm run pages:deploy`，并将 `why.hiwd.com` 绑定到 Pages 项目。

生产环境会调用 DeepSeek `deepseek-chat`，使用 OpenAI 兼容 SDK、`https://api.deepseek.com` 和 JSON object 模式。新闻优先使用 Finnhub 的免费公司新闻接口，Yahoo Finance RSS 仅作为无密钥备用来源。未配置密钥时，MVP 使用可重放的模拟总结，便于本地端到端演示。短期热点通过 `HOT_TICKERS` 环境变量动态加入，不写入永久核心池。

## 本地运行

```bash
npm run dev
```

前端请求 `/api/latest`。要在本地同时运行 API Worker，需要先创建 `.dev.vars`，再执行 `npm run cf:dev`。本期 `MARKET_DATA_MODE` 默认为 `mock`，用于验证触发、总结和 KV 写入链路。

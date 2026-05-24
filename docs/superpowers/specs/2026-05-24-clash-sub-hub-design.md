# Clash Sub Hub - 设计文档

## 概述

基于 Cloudflare Workers + KV 的 Clash 订阅聚合分发服务。管理员添加上游机场订阅和自建节点，服务定时缓存上游内容，通过独立 token 链接分发给用户。用户拿到合并后的节点列表，无法看到原始订阅 URL。

## 架构

单个 Cloudflare Worker，KV 作为唯一存储，Cron Trigger 定时拉取。

```
clash-sub-hub/
├── wrangler.toml
├── src/
│   ├── index.ts           # 路由入口（fetch handler + scheduled handler）
│   ├── auth.ts            # 管理员密码校验
│   ├── cron.ts            # 定时拉取上游订阅 → 写 KV
│   ├── subscription.ts    # 读 KV → 合并节点 → 输出 YAML 或 base64 URI
│   ├── converter.ts       # 节点解析与格式转换
│   ├── admin.ts           # 用户 CRUD + 上游管理 + 自建节点管理 API
│   └── ui.html            # 内嵌管理页面（单页 HTML）
├── package.json
└── tsconfig.json
```

## API

### 公开接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/sub/:token` | 订阅输出，默认 Clash YAML，`?format=base64` 输出 URI |
| GET | `/script.js` | 返回全局扩展脚本 |

### 管理接口（需 Admin 鉴权）

鉴权方式：请求头 `Authorization: Bearer {ADMIN_PASSWORD}`，密码通过环境变量 `ADMIN_PASSWORD` 配置。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin` | 管理页面（HTML） |
| GET | `/api/users` | 用户列表 |
| POST | `/api/users` | 创建用户 `{token, name}` |
| PUT | `/api/users/:token` | 更新用户（启用/禁用） |
| DELETE | `/api/users/:token` | 删除用户 |
| GET | `/api/upstreams` | 上游订阅列表（含状态） |
| POST | `/api/upstreams` | 添加上游订阅 `{name, url, userAgent?}` |
| PUT | `/api/upstreams/:name` | 更新上游订阅 |
| DELETE | `/api/upstreams/:name` | 删除上游订阅 |
| POST | `/api/upstreams/:name/test` | 测试单个上游订阅（fetch 并返回节点数和预览） |
| POST | `/api/upstreams/test` | 测试新 URL（不保存，仅验证连通性和节点数） |
| POST | `/api/refresh` | 手动刷新所有上游订阅 |
| GET | `/api/custom-nodes` | 自建节点列表 |
| POST | `/api/custom-nodes` | 添加自建节点（YAML/JSON 格式的单个节点配置） |
| PUT | `/api/custom-nodes/:name` | 更新自建节点 |
| DELETE | `/api/custom-nodes/:name` | 删除自建节点 |
| GET | `/api/script` | 获取全局扩展脚本 |
| POST | `/api/script` | 上传/更新全局扩展脚本 |

## KV 数据结构

```
"users"           → JSON: [
  {token: "xiaoming", name: "小明", enabled: true, createdAt: "2026-05-24T00:00:00Z"}
]

"upstreams"       → JSON: [
  {name: "BPB", url: "https://...", userAgent: "clash.meta", lastUpdate: "...", nodeCount: 12}
]

"cache:{name}"    → string: 上游订阅原始 YAML 内容（如 "cache:BPB"）

"custom-nodes"    → JSON: [
  {name: "自建-Reality", type: "vless", server: "...", port: 443, ...完整节点配置}
]

"script"          → string: 全局扩展脚本 JS 内容
```

## Cron 逻辑

- 触发频率：每小时（`0 * * * *`）
- 流程：
  1. 读取 `upstreams` 列表
  2. 并行 fetch 每个 URL（带自定义 User-Agent，默认 `"clash.meta"`）
  3. 成功 → 写入 `cache:{name}`，更新 `lastUpdate` 和 `nodeCount`
  4. 失败 → 保留旧缓存不覆盖，记录错误状态

## 订阅合并逻辑

请求 `/sub/:token` 时：

1. 读 `users`，校验 token 存在且 enabled，否则返回 403
2. 读所有 `cache:*`，解析 YAML 提取 `proxies` 数组
3. 对机场节点应用过滤正则：`^(?!.*(官网|套餐|流量|异常|剩余|ISP|all|免费|低倍率|0\.[0-9]x|测试|到期)).*$`
4. 读 `custom-nodes`，追加到节点列表（不过滤）
5. 按节点名去重
6. 输出：
   - 默认（无 format 参数）：Clash YAML，包含 `proxies` 数组
   - `?format=base64`：每个节点转为协议 URI（vless://, vmess://, ss://, trojan://, tuic://, hysteria2://），再 base64 编码

## 节点 → URI 转换（converter.ts）

支持的协议：
- **vless** → `vless://uuid@server:port?参数#name`
- **vmess** → `vmess://base64({json})` （v2ray 标准格式）
- **ss (Shadowsocks)** → `ss://base64(method:password)@server:port#name`
- **trojan** → `trojan://password@server:port?参数#name`
- **tuic** → `tuic://uuid:password@server:port?参数#name`
- **hysteria2/hy2** → `hysteria2://password@server:port?参数#name`

不支持的协议类型直接跳过，不中断合并。

## 管理前端（ui.html）

内嵌在 Worker 中的单页 HTML，无需构建工具。

页面结构：
- **登录**：密码输入框，验证通过后存 localStorage
- **用户管理 Tab**：表格（token、名称、状态、创建时间、操作按钮），新增表单（token + 名称），一键复制订阅链接
- **上游订阅 Tab**：表格（名称、最后更新、节点数、状态），新增表单（名称 + URL + UA），每行有「测试」「刷新」「删除」按钮
- **自建节点 Tab**：表格展示，新增/编辑使用 YAML 文本框输入
- **脚本管理 Tab**：代码编辑文本框 + 保存按钮

样式：使用 Tailwind CSS（CDN），简洁实用。

## 环境变量

| 变量 | 说明 |
|------|------|
| `ADMIN_PASSWORD` | 管理员密码 |

## wrangler.toml 配置

```toml
name = "clash-sub-hub"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[triggers]
crons = ["0 * * * *"]

[[kv_namespaces]]
binding = "KV"
id = "部署时生成"
```

## 部署步骤

1. `npm install`
2. 用户登录 CF：`npx wrangler login`
3. 创建 KV namespace：`npx wrangler kv namespace create KV`
4. 将返回的 id 填入 `wrangler.toml`
5. 设置密码：`npx wrangler secret put ADMIN_PASSWORD`
6. 部署：`npx wrangler deploy`
7. 访问 `https://clash-sub-hub.{用户子域名}.workers.dev/admin` 管理

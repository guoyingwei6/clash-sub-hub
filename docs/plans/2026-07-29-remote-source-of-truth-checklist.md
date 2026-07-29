# Clash Sub Hub 远端唯一配置源改造 Checklist

目标：让一个 Materialized 订阅链接等效替代本地 Clash Verge 的 Merge + Script。远端负责机场、自建节点、分组、规则和 DNS；客户端只导入链接，不再维护本地覆盖。

## 安全边界

- [x] 不把真实订阅 URL、token、UUID、密码或节点凭据写入 Git、fixture、日志或任务图。
- [x] 改造期间保留现有本地 Clash 配置作为回退。
- [x] 当前阶段不修改生产 KV，不部署正式 Worker，不轮换正式 token。
- [x] 未经用户单独明确同意，不导入/切换 Clash Verge 订阅，不修改客户端文件、系统代理或 TUN，不重启 Clash。
- [x] `main` 推送只运行 release gate；生产部署必须手动选择 `DEPLOY_PRODUCTION` 并进入 `production` environment。
- [ ] 生产切换前生成可回滚快照并由用户再次确认。
- [x] 明确告知分享边界：Materialized 输出隐藏上游订阅 URL，但订阅接收者仍可读取最终节点凭据。

## Phase 0：现状审计与目标冻结

- [x] 核对本地 Git、远端 Git 和线上 Worker 代码版本。
- [x] 对比本地 Merge、Script、运行时配置与远端管理数据。
- [x] 定位只追加导入、永久 `localFetch`、缺少 Cron、动态执行 JS、手动选择组缺节点等根因。
- [x] 建立任务 DAG 和生产切换门禁。

证据：

- `.agent-workbench/task-forest/exports/task-forest.html`
- `TF-0001` 至 `TF-0011`

## Phase 1：脱敏基线与测试护栏

- [x] 增加统一的 `npm test` 和 `npm run check`。
- [x] 使用保留域名、TEST-NET IP 和假凭据建立 Merge fixture。
- [x] 覆盖 Merge 解析、规范化、差异计算和序列化稳定性。
- [x] 覆盖 Materialized 分组引用完整性和全部节点可选性。
- [x] 覆盖刷新失败后仍可重试、陈旧缓存状态可观测。
- [x] 增加仓库敏感信息静态检查。

验收：

- [x] `npm run check` 全部通过。
- [x] fixture 不含真实主机、订阅链接和凭据。

## Phase 2：规范化远端配置模型

- [x] 定义带 `schemaVersion` 的权威配置结构。
- [x] 统一上游抓取模式：`server`、`mirror`、`disabled`。
- [x] 区分配置、运行状态和缓存内容，避免互相覆盖。
- [x] 记录 `lastAttemptAt`、`lastSuccessAt`、`cacheUpdatedAt`、失败次数和错误摘要。
- [x] 为旧 KV 数据提供兼容读取和迁移函数。

验收：

- [x] 旧数据可兼容读取，并在首次发布完整 artifact 时迁移到新模型。
- [x] 相同输入规范化后结构稳定。

## Phase 3：Merge 预览差异与全量替换

- [x] 导入默认只预览，不写入。
- [x] 预览列出上游和自建节点的新增、更新、删除、不变项。
- [x] 显式 apply 后写入包含完整 Materialized artifact 的新权威配置。
- [x] 写入前保存不可变 revision 快照，并以 30 天 TTL 限制旧凭据保留；纯 artifact 刷新不重复生成大快照。
- [x] 解析、缓存准备或 artifact 生成失败时不改变现有配置。
- [x] 管理后台展示差异并要求二次确认。

验收：

- [x] 同名项目可更新，远端多余项目可删除。
- [x] 重复导入相同 Merge 为零差异。
- [x] 失败路径保持旧配置不变。

## Phase 4：确定性完整配置生成

- [x] Materialized 输出只运行编译进 Worker 的受控生成逻辑。
- [x] 删除订阅请求路径中的 `eval` / `new Function`。
- [x] 将可调项收敛为经过 schema 校验的 YAML/JSON 设置。
- [x] 同一权威配置产生结构稳定的完整 Mihomo YAML。
- [x] 生成失败返回明确错误，不静默输出残缺配置。
- [x] 默认分享链接使用 Materialized 模式，不输出原始上游 URL。
- [x] 活动配置在单个 KV value 内同时携带配置与完整 artifact，避免跨键传播时出现半成品。

验收：

- [x] 输出包含 proxies、proxy-groups、rule-providers、rules、DNS 和 TUN 设置。
- [x] Materialized 文本不含任何上游订阅 URL。
- [x] 源码和构建产物的请求路径无动态 JS 执行。

## Phase 5：全部节点可见且分组引用正确

- [x] `节点选择` 包含全部获授权的物化节点。
- [x] 自动选择、家宽中转等组按各自过滤条件注入节点。
- [x] 所有分组引用均指向存在的节点或分组。
- [x] 同名节点经过稳定前缀和去重处理；自建节点优先于不受信任上游同名节点。
- [x] 零节点场景返回明确 503，不输出空的完整配置。

验收：

- [x] 契约测试证明测试用户可看到并手动选择全部授权节点。
- [x] 不存在空的关键分组和悬空引用。

## Phase 6：刷新、重试和受信任镜像

- [x] 恢复 Cron Trigger，并保留管理员手动刷新。
- [x] 抓取失败不会自动永久改成跳过刷新。
- [x] 增加有限重试、指数退避和下一次可重试时间。
- [x] 缓存陈旧时显示缓存年龄和最近成功时间。
- [x] 提供 HMAC Mirror 上传/预载接口和仓库内受信任 VPS 上传脚本。
- [x] 镜像内容经过大小、格式、节点数、时间戳、nonce 和鉴权校验。
- [x] 新 Mirror 的预览、预载和 apply 使用稳定 ID；活动刷新只有在 artifact 同步重建后才报告成功。
- [x] Provider 模式仅作为显式授权的降级方案，并提示会暴露上游 URL。

验收：

- [x] 模拟失败后下一轮仍会尝试。
- [x] 旧缓存可按策略继续服务，但不会显示为“正常且新鲜”。

## Phase 7：分享和管理安全

- [x] 服务端生成高熵随机订阅 token。
- [x] 支持按用户授权上游、自建节点、禁用、吊销和轮换。
- [x] 管理 API 不再接受 query 参数密钥。
- [x] 管理后台不把长期管理员密钥保存在 localStorage 或 sessionStorage。
- [x] 使用 15 分钟 HttpOnly、Secure、SameSite=Strict 的签名会话保护后台；Bearer 只保留给自动化客户端。
- [x] 自托管管理页浏览器依赖并配置 CSP。
- [x] 日志和错误信息统一脱敏。
- [x] 代码和公开 `/script.js` 已移除私有 DNS 路径；生产切换前仍需轮换可能已暴露的旧鉴权路径。

验收：

- [x] Staging 同一路径验证禁用、轮换和删除后旧订阅立即不可用。
- [x] 管理密钥不会出现在 URL、浏览器历史或第三方请求中。

说明：KV 跨地域传播意味着吊销和 nonce 消费不是强一致。正式生产若要求严格即时吊销、并发写 CAS 或全局原子 nonce，需要把这些状态迁移到 Durable Object；当前版本按单管理员、低并发运维设计。

## Phase 8：Staging 迁移与等效性验证

- [x] 建立独立测试 Worker / KV。
- [x] 用脱敏数据完整走一遍预览、应用、刷新、订阅和吊销。
- [x] 对真实配置只做本地内存比较，不写入仓库。
- [x] 用 Mihomo 检查生成配置语法。
- [x] 对比本地运行时与测试订阅的节点数、分组名、规则数、DNS/TUN 关键字段。
- [x] 形成迁移报告和回滚步骤。
- [x] 确认 `cacheWarnings` 为空且活动配置内 `materializedArtifact` 生成成功。

验收：

- [x] 无缺失节点、缺失关键分组、悬空引用或上游 URL 泄漏。
- [ ] 真实客户端导入测试链接后可见所有节点和分组。

证据：

- `docs/reports/2026-07-29-staging-validation.md`
- `scripts/staging-smoke.mjs`
- `scripts/local-equivalence-audit.mjs`

说明：真实客户端导入是独立安全门禁，当前按用户要求停在此处，未经再次明确授权不得执行。

## Phase 9：生产切换（需用户再次确认）

- [ ] 备份生产 KV 和当前有效订阅。
- [ ] 导入完整权威配置并刷新所有缓存。
- [ ] 为本人和分享对象生成并分配新 token。
- [ ] 验证正式 Materialized 链接。
- [ ] 用户明确确认后切换客户端。
- [ ] 观察稳定后再决定是否停用旧链接和本地 Merge/Script。

回滚条件：

- 任一关键分组缺失。
- 任一自建节点或获授权上游缺失。
- Mihomo 校验失败。
- 刷新状态无法判断或订阅泄露原始上游 URL。
- 客户端无法手动选择全部节点。

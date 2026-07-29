---
created: 2026-07-29
updated: 2026-07-29
---

# Clash Sub Hub Staging 等效性验证报告

## 结论

隔离 Staging 已完成脱敏端到端验证，远端 Materialized 单链接能够生成完整 Mihomo 配置，并支持 Merge 预览与全量替换、Mirror 更新、server 刷新、同链接 artifact 更新以及用户 token 生命周期。

本轮没有执行导入或切换 Clash Verge 订阅、写客户端文件、切换系统代理或 TUN、重启 Clash 等操作。也没有执行生产 Worker 部署、生产 KV 写入或生产 token 轮换；本报告没有对 Cloudflare 远端生产状态做独立审计。

真实客户端导入仍是单独门禁，必须得到用户明确授权后才可执行。

## 隔离环境

| 项目 | 值 |
|---|---|
| 主 Staging Worker | `clash-sub-hub-staging.guoyingwei6.workers.dev` |
| 主 Staging 版本 | `8d1d496f-b7e3-4359-9fa6-7414c9528072` |
| 脱敏 Provider Worker | `clash-sub-hub-staging-provider.guoyingwei6.workers.dev` |
| Provider 版本 | `ff2df89c-dbd7-4068-85df-e1a1b5b72d84` |
| 数据存储 | 独立 Staging KV |
| Fixture | TEST-NET 地址与假凭据，不含真实订阅或节点秘密 |

Staging 会话会回显并绑定 `deploymentEnvironment=staging`。Smoke 在任何 KV 写入前都会验证环境标记；在发送管理密码之前，还会要求主 Worker 和 Provider URL 与仓库登记的两个精确主机完全一致，伪前缀、端口、凭据、查询参数和片段均被拒绝。

为了让主 Staging Worker 通过真实全局 `fetch` 访问另一个 `workers.dev` Provider，只有 `wrangler.staging.toml` 启用了 `global_fetch_strictly_public`。生产配置没有加入该兼容标志。

## 脱敏端到端结果

`scripts/staging-smoke.mjs` 已完成并通过以下门禁：

- 15 分钟安全管理会话及登出。
- 随机旧基线到目标 Merge 的预览、删除差异和全量替换。
- Mirror 预载、激活上传以及 V2 内容替换。
- 唯一 server 上游的真实远端抓取；同一个 server URL 按测试时间窗从 V1 切换为 V2，刷新统计为 attempted 1、succeeded 1、failed 0，旧 server 节点随 artifact 一并消失。
- 同一个订阅链接命中活动配置内的 Materialized artifact，并在 Mirror 与 server 内容更新后同步变化。
- 7 个节点的完整字段逐项匹配 fixture；18 个分组的类型、成员和顺序逐组匹配基线。
- 默认 Materialized 模式可用；未授权 Provider 模式被拒绝。
- token 轮换、禁用、恢复和删除。
- 输出不含上游源 URL。
- Mihomo `-v` 身份检查和 `-t` 强制校验通过；非 Mihomo 程序、缺少路径或校验超时均会使 smoke 失败。

最终脱敏输出：

| 指标 | 结果 |
|---|---:|
| 节点 | 7 |
| 分组 | 18 |
| 规则 | 116 |
| `cacheWarnings` | 0 |
| Materialized artifact | ready / hit |
| 悬空分组引用 | 0 |
| 上游 URL 泄漏 | 0 |

脱敏 smoke 摘要：

```json
{
  "ok": true,
  "checks": {
    "replaceImport": true,
    "sameLinkArtifactUpdate": true,
    "refresh": true,
    "materialized": true,
    "tokenRotateDisableEnableDelete": true,
    "mihomo": true
  },
  "counts": {
    "proxies": 7,
    "groups": 18,
    "rules": 116
  },
  "sourceUrlLeak": false
}
```

## 真实本地配置只读等效性

`scripts/local-equivalence-audit.mjs` 只读取当前 Clash Verge 的 Merge、脚本、运行时配置与 Provider 缓存，在内存中构造候选结果；它不会写客户端配置，也不会打印源 URL、token、节点名称或凭据。

| 指标 | 当前本地运行时 | 远端候选 |
|---|---:|---:|
| Provider | 17 | 17 |
| 自建节点 | 4 | 4 |
| 物化节点 | 921 | 921 |
| 分组 | 18 | 18 |
| 原始规则 | 120 | — |
| 去重后规则 | 116 | 116 |
| 手动选择可见节点 | — | 921 |

审计通过：

- Merge 与实际运行时分别读取和物化；两条独立链路的 Provider、自建节点数量和最终时点的 921 个完整节点对象一致。
- Provider 缓存齐全，Provider 数量、节点 schema 与过滤配置匹配。
- 分组名称和类型一致。
- 去重后的规则内容与顺序一致；本地运行时的 4 条重复规则被确定性去重。
- 手动选择组包含最终时点的全部 921 个节点；自动选择组只包含 Provider 节点。
- 没有悬空分组引用，也没有上游 URL 出现在候选 Materialized 输出。
- TUN stack、strict-route 和 DNS enhanced-mode 一致。
- 本地 route exclusions、fake-ip-filter 追加项以及国内外 DNS 数组都能由远端 schema 表达。
- 含 921 个真实节点的候选 YAML 通过标准输入送入 Mihomo 校验，未将配置写入临时文件；审计任一布尔项失败会返回非零退出码。

机场 Provider 缓存是实时变化的：较早快照为 923 个节点，最终复核时变为 921 个。节点总数不是永久常数；验收标准是同一次审计中运行时与候选的完整节点对象、分组和规则一致。

最后一项表示“远端模型能够安全保存这些设置”，不表示私有 DNS 地址已经写入 Git 或脱敏 Staging。真实敏感值只能在生产切换时通过受保护的远端配置写入。

## 验证追溯

| 项目 | 值 |
|---|---|
| 验证完成时间 | `2026-07-29 18:20:12 +0800` |
| Git 基线 | `be29b1cbbfceb3ebd5d421e80818ff628e59d627` |
| 关键未提交验证输入组合 SHA-256 | `abb96998af99e1d761e7a6c56b8c6631f41c6ff1dee916b3afda9cb1096a28bc` |
| 自动测试 | 16 个文件、97 项通过 |
| Mihomo | `Mihomo Meta v1.19.29 darwin arm64` |
| npm audit | 0 vulnerabilities |

Git 基线只是当前 `HEAD`；本轮源码尚未提交。上面的组合哈希绑定 smoke、只读审计、生成脚本、Materialized 路径、Staging Provider、fixtures 和两份 Staging Wrangler 配置，用于区分后续工作区改动。

组合哈希可按固定文件顺序复算：

```bash
shasum -a 256 \
  scripts/staging-smoke.mjs \
  scripts/local-equivalence-audit.mjs \
  ClashVerge-AI-Academic-Enhanced.js \
  src/subscription.ts \
  src/staging-provider-worker.ts \
  tests/fixtures/staging-merge.yaml \
  tests/fixtures/staging-provider.yaml \
  tests/fixtures/staging-provider-v2.yaml \
  wrangler.staging.toml \
  wrangler.staging-provider.toml |
shasum -a 256
```

## 分享边界

Materialized 订阅会隐藏机场原始订阅 URL，但任何拿到订阅的人都能够读取最终节点的连接参数。正式分享时必须为每个对象生成独立随机 token，以便单独禁用、轮换和吊销。

## 回滚与下一门禁

本轮没有对本机客户端或线上生产执行写操作，因此没有这两类运行状态需要恢复。工作区内包含尚未提交、尚未推送的生产目标源码和部署流程改动；`main` 推送现在只运行 release gate，生产部署改为手动确认并进入 GitHub `production` environment。若 Staging 不再需要，只需停止使用其测试链接；删除 Staging Worker 或 KV 属于破坏性操作，必须另行明确确认。

生产切换前仍需：

1. 备份生产 KV 与现有有效订阅。
2. 在受保护的远端配置中录入真实敏感参数并刷新全部上游。
3. 验证正式 Materialized 链接和新 token。
4. 得到用户明确授权后，才允许在 Clash Verge 中导入测试或正式链接。
5. 客户端出现缺组、缺节点、Mihomo 错误、刷新异常或无法切换时，立即恢复原本地配置。

# OPCAI

**OPCAI —— 跨平台、本地优先的「数字员工」AI 工作台**

> **语言：** 中文 (zh-CN) · [English](README.md)
>
> 采用「根 README 索引 + 语言分档」结构，本文件为中文全文。

---

OPCAI 是一套桌面级 Agent 工作台：其中的“数字员工”可以对话、运行**项目编排**、使用 **Skills**、检索**知识库 / MCP 连接 / 联网搜索**，并且能通过**本地通道网关**被外部 IM（Telegram / 飞书）乃至**远程中继终端**调度。与常见“聊天壳 + 状态都在前端”的 Agent 应用不同，OPCAI 把所有重编排放进**服务端状态机**：桌面 UI、IM 通道与未来的远程终端共享同一份会话/运行/审批/项目状态。

仓库刻意保持 Electron 壳“薄”：

```text
Electron shell  →  本地 Fastify API  →  agent-core（Vercel AI SDK）→ providers
Vue renderer ────── HTTP / SSE ────────┘
通道网关 ───────── HTTP / SSE ──────────┘（Telegram / 飞书 / 远程中继）
```

## 能力一览

| 能力 | 说明 |
| --- | --- |
| 数字员工 | 职责与授权载体：可配模型、Skills、运行时偏好与权限档位（read-only/default/extended/full） |
| Skill（渐进加载） | 先授权元信息 → 按需读 `SKILL.md` → 才可在隔离运行工作区访问资源/执行脚本 |
| 项目编排 | 目标 → 任务草案 → 人工确认 → 服务端调度器（parallel/waterfall/DAG）在多员工间派发 |
| 可续跑审批 | 工具审批把运行停在 `waiting-approval`；决议后自动以同 turn 新 attempt 续跑 |
| 会话滚动记忆 | 本会话 `memory.summary` + 水位线；超预算自动摘要，切换会话 flush；消息全文仍是真相 |
| 项目双工作区 | 过程产物在员工 run 空间；最终交付经 `publish_to_project` 进入项目目录并显示在左侧文件树 |
| 知识库 / MCP / 搜索 | 本地 LanceDB + 云端知识库、MCP(http/sse/stdio)、多搜索商（含敏感词脱敏与降级） |
| 通道与远程办公 | 独立网关子进程：Telegram/飞书适配器 + 个人白名单；远程中继设备出连(WS)供终端调度 |
| 本地优先存储 | 域数据单一写者（api 进程）；密钥在主进程 `safeStorage` 加密、仅经 fork IPC 一次性下发 |
| 「远程办公/连接」门户 | P1 视图：管理 Telegram/飞书凭证、白名单、默认员工与网关状态/重启 |

## 仓库结构（pnpm monorepo）

| 路径 | 职责 |
| --- | --- |
| `apps/desktop` | Electron 主进程（薄）：IPC、sql.js 密钥/资产、fork api 与 gateway |
| `apps/renderer` | 纯浏览器 Vue 3（Vite+Tailwind）；只走 HTTP/SSE 与 IPC |
| `apps/api` | localhost Fastify 服务，托管编排层（`/api/orch/**`）与域 KV |
| `apps/gateway` | 通道网关子进程：Telegram/飞书/中继适配器、白名单 |
| `packages/contracts` | 共享 Zod 契约（单一事实源） |
| `packages/agent-core` | 唯一允许调用 Vercel AI SDK 的层 |
| `packages/tools` | 工具契约 + 风险标签 |
| `packages/orchestrator` | 服务端会话/项目状态机、存储服务、可续跑 run |
| `packages/channel` | 与传输解耦的通道协议（`UnifiedMessage/IChannel/registry/StreamSink`） |
| `packages/storage`、`packages/ui-kit` | 预留占位 |

当前完整架构与模块职责见 [docs/design/architecture.md](docs/design/architecture.md)。

## 快速开始

要求：Node.js ≥ 22、pnpm ≥ 10（`packageManager` 已固定）。

```bash
pnpm install
pnpm dev        # 桌面开发：先构建 workspace 包，再起 Vite + Electron
pnpm typecheck
pnpm build
pnpm package    # electron-builder 打安装包
```

在“设置 → 模型”配置 Provider 之前不会存储/使用任何模型密钥。无头/CI 冒烟脚本见 `scripts/*-smoke.mjs` 与设计文档。

## 发布

推送形如 `v0.1.0` 的 SemVer tag 触发发布工作流，产出三种安装包：

| 平台 | 架构 | 安装包 |
| --- | --- | --- |
| macOS | Apple Silicon (arm64) | `.dmg` |
| macOS | Intel (x64) | `.dmg` |
| Windows | x64 | NSIS `.exe` |

Linux 打包暂在 CI 停用（细节见 `.github/workflows/release.yml` 注释）。

## 文档导航

| 语言/主题 | 入口 |
| --- | --- |
| 架构与模块 | [docs/design/architecture.md](docs/design/architecture.md)（当前权威） |
| 设计文档索引与状态 | [docs/design/README.md](docs/design/README.md) |
| 通道网关里程碑 | [M0](docs/design/gateway-m0.md) · [M0 验收清单](docs/design/gateway-m0-acceptance.md) · [M1](docs/design/gateway-m1.md) · [M2](docs/design/gateway-m2.md) |
| 需求/架构/测试规格（早期） | `docs/sdd/*` |

## 通道网关里程碑状态

| 里程碑 | 状态 |
| --- | --- |
| M0 编排层 | ✅ 会话/项目状态机、域存储服务、可续跑审批、`/api/orch` REST+SSE |
| M1 网关 + Telegram | ✅ `@opcai/channel` 协议、`apps/gateway`、Telegram 适配器 + 白名单；桩验收 ALL PASS |
| M2 门户 + 飞书 + 远程中继 | ✅ P1 门户与凭证链路(IPC+safeStorage)、P2 飞书适配器、P3 最小远程中继；桩验收 ALL PASS |

## 许可

仓库尚未声明公开 LICENSE（内部项目），正式开源前请由所有者补充。

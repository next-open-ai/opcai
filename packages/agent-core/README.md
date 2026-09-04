# @opcai/agent-core

唯一允许调用 Vercel AI SDK 的模型执行层。

## 上下文相关能力

| 能力 | API | 持久化 | 作用范围 |
| --- | --- | --- | --- |
| Step compaction | `compactMessagesForStep` | 否（仅当次 `streamText`） | 单次 run 内超长 tool/reasoning |
| Plain / session summary | `summarizePlainTurns` / `summarizeSessionMemory` | 由调用方决定 | 供 orchestrator 会话滚动记忆使用 |
| Summary 注入块 | `sessionSummaryMessagePair` / `SESSION_SUMMARY_PREFIX` | — | 与会话记忆共用同一前缀文案 |
| 项目交付晋升 | `publish_to_project`（`skill-runtime`） | 写入项目目录 | 仅项目绑定 run；过程脚本禁止晋升 |

会话级滚动记忆的水位线与落盘在 `@opcai/orchestrator`（见该包 README），本包只提供摘要模型调用与注入格式。

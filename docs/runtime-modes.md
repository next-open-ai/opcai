# OPCAI Runtime Modes

本文说明 OPCAI 当前几种运行形态的定位、能力边界，以及 Web / npm / Docker 相对桌面版的退化行为。结论优先：

- `desktop` 仍是当前能力最完整、最接近“正式使用”的形态。
- `web launcher` 与 `npm` 入口已经可用，适合本机无头启动、浏览器访问、CI 冒烟和远程调试。
- `Docker` 已具备根镜像与 CI 构建校验能力，但当前更适合作为“可构建的 Web runtime 封装”，不应描述为与桌面版完全等价。

## 运行形态一览

| 形态 | 启动方式 | 当前定位 | 能力结论 |
| --- | --- | --- | --- |
| Desktop | `pnpm dev` / `pnpm package` 后安装包运行 | 主推荐形态 | 能力最完整 |
| Web launcher（源码） | `pnpm build && pnpm web:start` | 本机浏览器访问、CI 冒烟、无头调试 | 核心对话/项目/网关可用，缺少 Electron 原生能力 |
| npm / CLI launcher | `npx/pnpm dlx/pnpm add` 后 `opcai start` | 分发同一套 Web runtime | 与 Web launcher 基本一致 |
| Docker | `docker build` 后 `docker run` | 可复现封装、镜像分发、CI 构建校验 | 可构建；运行能力受当前 Web runtime 边界约束 |

## Desktop

桌面版由 `Electron main + 本地 Fastify API + renderer + gateway child process` 组成，当前拥有以下完整能力：

- 使用 Electron IPC 提供原生文件选择、目录选择、Reveal/Open、资产保存、环境检查等能力。
- 模型 / 搜索 / 通道凭证通过主进程 `safeStorage` 加密保存，仅在子进程启动时按需下发。
- `apps/gateway` 由主进程 fork 管理，远程办公 / Channels 门户可以查看状态、保存配置并触发重启。
- 项目空间、资产库、本地 Skill 管理等流程可使用桌面原生文件系统交互。

如果希望得到与 README、设计文档中描述最一致的产品体验，应优先使用桌面版。

## Web launcher / npm

`pnpm web:start` 与 `opcai start` 都会启动同一套本地 Fastify 入口：API 提供 `/api/**`，同时托管 `apps/renderer/dist` 静态站点。它们的优势是分发简单、易于做 CI 冒烟，并且不依赖 Electron 壳。

当前这两种入口已覆盖：

- 浏览器中的主界面与基础导航。
- 对话、项目编排、审批续跑、资产/知识库/MCP/Skill 等 API 驱动能力。
- `/api/remote/*` 远程通道设置与 gateway 状态/重启接口。
- 根 `bin/opcai.mjs` 提供 `start` / `init` / `doctor`，可作为 npm 包入口。

### 相对桌面版的退化行为

Web launcher / npm 不是桌面壳，因此以下差异需要显式说明：

1. 没有 `safeStorage`。  
   桌面版中的模型/搜索密钥由主进程加密保存；Web runtime 下不存在该加密层。当前实现里：
   - 模型与搜索配置走浏览器本地存储；
   - 远程通道凭证由 API 侧写入 `OPCAI_DATA_DIR` 下的运行时文件。

2. 没有 Electron 原生 IPC。  
   文件选择、系统对话框、Reveal in Finder/Explorer、资产另存为、桌面环境检查等桌面专属动作不可等价提供。

3. gateway 的“管理方式”不同。  
   桌面版由主进程 fork 并代管；Web runtime 则通过 `/api/remote/*` 在 API 进程侧保存配置并拉起/重启 gateway。

4. 某些界面文案仍然以桌面为主。  
   当前仓库中的一部分说明文字仍偏向桌面端产品语境；判断能力可用性时，应以实际 runtime 边界和本文档为准。

## Docker

根 `Dockerfile` 打包的是 Web runtime 所需的最小产物：

- `bin/opcai.mjs`
- `apps/api/dist`
- `apps/renderer/dist`
- `apps/gateway/dist`
- `packages/channel/dist`

镜像目标是让 OPCAI 具备：

- 可复现的运行时封装；
- npm/Web runtime 的容器化分发载体；
- CI 中可验证的 Docker build 链路。

### 当前 Docker 边界

Docker 支持当前应表述为“镜像可构建且被 CI 校验”，而不是“已达到完整生产部署形态”。原因包括：

1. 镜像承载的是 Web runtime，而非桌面版。  
   因此不具备桌面版的 `safeStorage`、原生文件对话框、桌面打包壳等能力。

2. 容器运行时能力以本地 launcher 为准。  
   也就是说，核心 API/UI 资源可以随镜像一起封装，但桌面专属能力不会自动在容器里出现。

3. 当前更适合做构建验证与受控试运行。  
   CI 已纳入 `docker build` 校验；若要把容器运行描述为“稳定对外服务”，还需要后续把运行时监听、部署姿态和运维预期进一步收敛。

## 推荐说法

为了让外部文档与实现保持一致，建议统一使用下面的表述：

- “OPCAI 当前同时提供 desktop、web launcher、npm 和 Docker 入口。”
- “Desktop 是完整能力形态；web/npm 共享一套本地 Fastify + 静态站点 runtime。”
- “Docker 已提供根镜像并纳入 CI 构建校验，但当前能力边界与 Web runtime 一致，属于可运行封装而非桌面等价替代。”

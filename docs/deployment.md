# OPCAI Deployment Notes

本文聚焦当前仓库里已经存在、并且与 CI / release 保持一致的部署与分发路径。

## 1. Desktop installers

桌面版仍是主要交付方式。

- 开发启动：`pnpm dev`
- 本地构建：`pnpm build`
- 本地桌面打包：`pnpm package`

当前 GitHub Actions 会校验：

- macOS 桌面打包
- Windows 桌面打包

Release 工作流在打 tag 时发布安装包；当前保留：

- macOS Apple Silicon `.dmg`
- Windows x64 `.exe`

Intel macOS 与 Linux 发布暂未开启时，应在文档里明确写“当前未在 release workflow 中产出”，不要默认承诺。

## 2. Web launcher（源码）

适合本机无头启动、浏览器访问和 CI 冒烟：

```bash
pnpm install
pnpm build
pnpm web:start
```

默认数据目录：

- `~/.opcai`
- 或通过 `OPCAI_DATA_DIR` 覆盖

常用环境变量：

- `OPCAI_API_PORT`：本地 API / Web 入口端口，默认 `4318`
- `OPCAI_DATA_DIR`：运行数据目录

CI 中会运行 `pnpm web:smoke`，至少验证：

- `/api/health`
- `/`
- `/api/remote/gateway/status`

这保证“已构建的 Web runtime 可以启动并响应基础入口”，但不等同于桌面能力验收。

## 3. npm / CLI launcher

根包提供 `opcai` 二进制入口，命令如下：

```bash
opcai init
opcai doctor
opcai start
```

其中：

- `init` 预创建数据目录；
- `doctor` 检查当前包内容与数据目录；
- `start` 启动与 `pnpm web:start` 相同的 Web runtime。

npm / CLI launcher 的能力边界与 `docs/runtime-modes.md` 中的 Web runtime 相同。

## 4. Docker

构建：

```bash
pnpm build
docker build -t opcai:local .
```

仓库根 `Dockerfile` 依赖已构建产物，因此本地或 CI 中都需要先执行 `pnpm build`。

当前建议把 Docker 视为：

- Web runtime 的容器封装；
- 发布前的构建可用性检查；
- 后续部署链路的基础骨架。

当前 CI 只把 Docker 纳入“构建校验”，即验证镜像能成功 `docker build`。这符合当前实现状态，也避免把尚未完全收敛的运行时行为描述成稳定生产能力。

## 5. CI / Release 对齐

当前建议的职责划分如下：

- `ci.yml`
  - Ubuntu 基础构建与 typecheck
  - Web runtime smoke
  - Docker build 校验
  - macOS / Windows 桌面打包校验

- `release.yml`
  - tag 触发的发布前校验
  - macOS / Windows 安装包产出
  - GitHub Release 资产上传与 checksum 生成

如果未来补齐容器运行姿态、反向代理、监听地址或更完整的部署说明，再扩展本文即可；在那之前，不应把 Docker 描述为“桌面版部署替代品”。

# 开发指南

## 固定工具链

项目统一使用 Node.js 22.14.0 和 pnpm 11.25.0。版本由 `.node-version`、`package.json` 的 `engines` 和 `packageManager` 同时约束；安装依赖必须使用 `pnpm install --frozen-lockfile`。所有文本文件使用 UTF-8，脚本和命令文件的换行规则由 `.gitattributes` 与 `.editorconfig` 固定。

## Windows 开发路径

Windows 后端开发需要 Windows 10/11、WSL2、Docker Desktop、Git 和 PowerShell 5.1 或 7。客户连接器不需要这些组件。

1. 安装并启动 WSL2 与 Docker Desktop，启用 WSL integration。
2. 在 WSL 中进入项目目录。
3. 在 PowerShell 运行 `scripts/bootstrap-windows.ps1`，脚本会检查 WSL、Docker、Compose 和 Git，创建匿名开发卷并启动 PostgreSQL 与应用容器。
4. 浏览器打开脚本输出的本地地址。测试数据只存在开发卷中。
5. 修改代码后使用 `scripts/start-dev.ps1` 或 Docker Compose 重新构建。

路径包含空格或中文时，脚本使用自身目录定位项目，不依赖当前工作目录。客户连接器使用 `%~dp0` 和包内 Node，支持 Chrome、Edge 及 `CHROME_BIN` 自定义路径。

## macOS/Linux

安装 Node 22.14.0 与 pnpm 11.25.0 后执行：

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm preflight
pnpm dev
```

`DATA_DIR`、`PUBLIC_ORIGIN`、`MATRIX_CLOUD_URL` 和 `CONNECTOR_PACKAGES_DIR` 均应通过环境变量配置；不要在脚本中写入服务器 IP、个人目录或生产密钥。

## 测试与调试

- `pnpm build`：TypeScript 增量检查和 Vite 构建。
- `pnpm test`：Vitest 全量测试。
- `pnpm preflight`：版本、锁文件、路径和敏感内容预检。
- `python3 -m py_compile scripts/*.py`：Python 脚本语法检查。
- `docker compose -f compose.dev.yaml config`：Compose 配置检查。

本地 SQLite 通过 `server/sqlite-client.ts` 使用 Node 内置 `node:sqlite`，不要求安装 `sqlite3.exe`。数据库文件仍保持现有表结构，生产数据仍以 PostgreSQL 为准。

## 变更原则

修改业务逻辑前先补回归测试。不要为了打包修改供应商、费用、素材或图片数量配置；生产快照和客户登录状态必须在源码包外管理。

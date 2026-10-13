# 矩阵云

矩阵云是面向团队的内容管理、账号同步、素材处理和发布工作台。普通交接包只包含源码、配置模板、构建脚本和文档；生产数据库、客户媒体、浏览器登录状态、密钥及 MCP 凭证必须通过单独的加密迁移包交付。

## 快速开始

### 客户使用

客户只需解压对应的连接器 ZIP 并运行 `START-CONNECTOR.bat`（Windows）或 `启动连接器.command`（macOS）。连接器自带运行时，不要求客户安装 Node、pnpm、Python、WSL2 或 Docker。浏览器中打开工作台后，在“连接设置”完成配对，再按页面提示扫码登录。登录状态留在客户自己的浏览器配置中，不会进入源码包或云端迁移包。

### 开发者使用

Windows 开发采用 WSL2 + Docker Desktop；macOS/Linux 可直接使用锁定的 Node.js 与 pnpm：

```text
Node.js 22.14.0
pnpm 11.25.0
```

在项目根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm preflight
pnpm build
pnpm test
```

首次 Windows 环境可运行 `powershell -ExecutionPolicy Bypass -File scripts/bootstrap-windows.ps1`。本地服务使用 `compose.dev.yaml`，不会挂载生产数据。

## 目录

- `server/`：Express API、PostgreSQL/本地 SQLite 适配、队列与维护 MCP。
- `src/`：React + Vite 工作台。
- `local-connector/`：客户电脑上的浏览器连接器。
- `scripts/`：开发、预检、迁移和发布脚本。
- `deploy/`：Docker、反向代理和生产配置模板。
- `docs/`：客户、维护和迁移文档。
- `migration/`：生产快照导入说明（快照本身不在源码包）。

## 业务兼容边界

本次交接和跨平台改造不改变生图、生文案供应商、成本配置、素材库、洗图二创、账号同步、草稿保存或一次生成 1–12 张图片的既有能力。真实平台验收必须使用获授权且状态正常的账号；连接器速度参数用于控制请求密度，不能承诺第三方平台零限制或零封禁。

## 安全边界

不要把 `.env`、生产快照、Cookie、浏览器 Profile、私钥、MCP Token 或客户媒体提交到普通源码包。生产部署使用独立密钥管理和加密迁移包；上线前执行 `pnpm preflight`，任何旧服务器地址、凭证或路径残留都会阻止发布。

更多内容见 [DEVELOPMENT.md](DEVELOPMENT.md)、[ARCHITECTURE.md](ARCHITECTURE.md)、[OPERATIONS.md](OPERATIONS.md) 和 [RELEASE.md](RELEASE.md)。

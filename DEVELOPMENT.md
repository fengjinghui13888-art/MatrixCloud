# 分离版本开发指南

使用 Node.js 22.14.0–24.x、pnpm 11.25.0。先在项目根目录运行 `pnpm install --frozen-lockfile`，不要为两个文件夹生成不同锁文件。

- `pnpm dev` 同时启动前端 5173 和后端 4174；`PUBLIC_ORIGIN=http://127.0.0.1:5173` 用于认证写入请求。
- Windows 双击 `START-LOCAL-DEV.bat`，或运行 `scripts/start-local-dev.ps1`，它设置本机隔离数据，不会复用原项目生产状态。
- 前端入口 `frontend/src/main.tsx`；Vite 配置 `frontend/vite.config.ts`。前端不可导入 `backend/`。
- 后端入口 `backend/server/grey.ts`；路由 `backend/server/grey-app.ts`，路径由 `runtime-paths.ts` 相对仓库根目录解析，与启动时所在文件夹无关。
- 公共类型位于 `shared/domain.ts`、`shared/creation.ts`；模板和协议也在 `shared/`。
- `pnpm build` 分别检查两个子项目并构建前端；`pnpm test` 包含页面、后端和连接器测试。
- `pnpm test:frontend` 或 `pnpm test:backend` 在子项目测试配置中将工作目录固定到项目根目录，因此测试里的工具路径能正常解析。
- Python 打包测试需要 Python 3.9+。本机使用 `$env:PYTHON='C:\Users\huake\AppData\Local\Programs\Python\Python313\python.exe'`；目标电脑应改为自己的 Python 路径。

Docker 开发入口为 `compose.dev.yaml`，页面在 http://127.0.0.1:8080/，默认 SQLite，PostgreSQL 单独准备供迁移验证。修改代码后重新构建对应服务。当前环境没有 Docker 命令，尚未实测容器。

保留现有供应商、费用、图片数量默认值和 1–12 张范围；素材及登录状态不参与源码整理。拆分后的 `.env` 仍是后端运行环境：运行 `pnpm`/`tsx` 不会自动加载它，应通过启动环境或 Compose 的 env_file 注入。

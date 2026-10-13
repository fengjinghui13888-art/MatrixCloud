# 矩阵云 React 前端

页面保持原有 React 功能与样式。后端 API、MCP 和连接器已迁移到旁边的 Python backend 目录。

安装 Node.js 22.14–24 和 pnpm 11.25.0，在本目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

打开 http://127.0.0.1:5173/。同时需要启动 backend 的 Python 服务，默认 API 为 http://127.0.0.1:4174/。Vite 将 /api 和 /mcp 转发到后端，也转发 WebSocket；自定义后端地址使用 BACKEND_URL 环境变量。

Windows 可双击 START-FRONTEND.bat。要同时启动前后端，双击 backend/START-ALL.bat。

当前本机后端使用 PostgreSQL；数据库仅由 Python 后端访问。前端启动与构建不需要数据库凭证，禁止把 DATABASE_URL、供应商密钥或后端 .env 放入本目录。后端独立启动和数据库管理见 [数据库与启动](../backend/docs/数据库与启动.md)。

`pnpm build` 构建；`pnpm test` 跑页面回归测试。contracts 为前端使用的数据类型和恢复判断；本目录不依赖项目根目录的共享文件或配置。

不能删除 src、contracts、index.html、package.json、pnpm-lock.yaml、tsconfig.json、vite.config.ts。node_modules 和 dist 可重新生成；删除 node_modules 后需重新安装依赖，删除 dist 后需重新构建。

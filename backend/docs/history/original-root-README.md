# 矩阵云 · 前后端分离源码

本目录是从桌面 `MatrixCloud-Dev` 的当前工作文件复制后拆分得到的独立源码副本，包含原有未提交修改。原项目、素材、数据库和登录状态未改动。分离版本尚未上线。

## 目录

```text
MatrixCloud-Separated/
├─ frontend/                 React 页面、样式、Vite、前端测试
│  ├─ src/
│  ├─ package.json
│  ├─ vite.config.ts
│  ├─ tsconfig.json
│  ├─ Dockerfile
│  └─ nginx.conf
├─ backend/                  Express API、认证、业务、后端测试
│  ├─ server/
│  ├─ package.json
│  ├─ vitest.config.ts
│  └─ tsconfig.json
├─ shared/                   双方共用的类型、模板和连接器协议
├─ scripts/                  执行器、启动、打包、迁移与运维工具
├─ local-connector/          客户电脑上的浏览器连接器
├─ workbuddy-connector/      WorkBuddy 连接器配套文件
├─ deploy/                   入口代理及维护服务配置
├─ migration/                数据迁移说明
├─ docs/                     删除指南、逐文件清单、验证记录
├─ package.json              统一开发命令和根目录工具依赖
├─ pnpm-workspace.yaml       两个子项目的工作区配置
└─ pnpm-lock.yaml            锁定依赖版本
```

前后端有独立配置，在一个 pnpm workspace 内开发。`shared/` 和连接器工具是双方的依赖；部署和交付时须按 Dockerfile/打包脚本包含相应文件。

## 本机启动

Node.js 22.14.0–24.x、pnpm 11.25.0。Windows 可双击 `START-LOCAL-DEV.bat`，它会使用隔离的本机数据目录 `work/local-dev`。也可以执行：

```powershell
pnpm install --frozen-lockfile
$env:PUBLIC_ORIGIN = 'http://127.0.0.1:5173'
$env:DATA_DIR = './work/local-dev'
pnpm dev
```

打开 http://127.0.0.1:5173/；后端健康地址 http://127.0.0.1:4174/api/health。前端通过 Vite 代理 `/api`、`/mcp` 和连接器 WebSocket。后端根路径 `/` 返回 404，是 API 服务的预期行为。端口已被其他项目占用时先确认现有进程，启动脚本不会结束其他系统。

分别启动：根目录 `pnpm dev:frontend` 和 `pnpm dev:backend`，或在 `frontend/`、`backend/` 内分别运行 `pnpm dev`。前端代理目标可通过 `BACKEND_URL` 改写；后端 `PORT` 与 `PUBLIC_ORIGIN` 要同步配置。

## 构建与检查

```powershell
pnpm build
pnpm preflight
$env:PYTHON = 'C:\Users\huake\AppData\Local\Programs\Python\Python313\python.exe'
pnpm test
```

前端输出 `frontend/dist/`；后端通过 `tsx` 执行 TypeScript，`backend build` 完成类型检查。`pnpm test:frontend`、`pnpm test:backend` 可单独检查子项目。Python 路径应替换为目标电脑的 Python 3.9+；本机默认 Python 3.8 不能运行现有连接器打包脚本的全部功能。

## 部署

后端镜像由根目录 `Dockerfile` 构建，前端镜像由 `frontend/Dockerfile` 构建；两者都使用项目根目录作为构建上下文。入口 nginx → frontend nginx → backend API，同域认证无需增加跨域授权。

```powershell
docker build -t matrix-cloud-backend:your-release -f Dockerfile .
docker build -t matrix-cloud-frontend:your-release -f frontend/Dockerfile .
```

开发容器 `docker compose -f compose.dev.yaml up -d --build` 以 SQLite 启动本机工作台，页面端口为 8080；其中 PostgreSQL 是独立的迁移验证资源，不会自动接入或迁移。生产见 `compose.prod.example.yaml`、`OPERATIONS.md`。生产数据库、媒体、密钥和当前回滚包需要单独迁移，不能删除原项目后再尝试恢复。

分离版本的旧维护发布器已明确拒绝自动构建发布/回滚；它原本只管理一个业务容器。生产维护须升级为绑定同一版本的双容器发布与回滚，再进行真实验收。此副本未连接、替换或部署到线上服务。

## 删除说明

先看 [文件与代码删除指南](docs/文件与代码删除指南.md)，逐文件记录见 [file-deletion-inventory.csv](docs/file-deletion-inventory.csv)。指南包含可再生目录、条件删除项、未被页面入口引用的代码候选和必须保留的业务/运维代码。没有自动删除任何业务文件。

[验证记录](docs/verification/2026-10-13-separation.md)区分构建、模拟测试、本机 API/浏览器检查、Docker 和真实平台待验项。`SOURCE-SNAPSHOT.json` 保存原始来源和每个源码文件的哈希。

2026-10-13 已按指南移除三份闲置源码和三个未使用依赖；清理范围、恢复位置及验证见 [清理记录](docs/verification/2026-10-13-cleanup.md)。

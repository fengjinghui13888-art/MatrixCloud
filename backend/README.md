# 矩阵云 Python 后端

当前目录使用 Python 3.13 + FastAPI，包含业务 API、MCP、本机连接器和执行工具。浏览器页面继续使用 React，位于旁边的 frontend。

## Windows 启动

本机依赖已经安装。双击 **START-ALL.bat**，浏览器会打开 http://127.0.0.1:5173/。保持窗口打开，按 Ctrl+C 停止前后端。第一次在页面创建账号，已有数据目录则使用原账号。

ALL 是本机开发启动入口，前后端只监听回环地址并使用本机 HTTP；即使旧 .env 配有 TLS，也不会把这个入口暴露到公网。单独 server 模式保留 TLS_CERT/TLS_KEY 与生产配置。

换电脑时先安装 Python 3.13、Node.js 22.14–24 和 pnpm 11.25.0，再双击 SETUP.bat 安装依赖，然后运行 START-ALL.bat。Node.js 用于 React 的开发和构建，业务后端由 Python 执行。

分别启动：backend/START-BACKEND.bat 对应 API 端口 4174；frontend/START-FRONTEND.bat 对应页面端口 5173。不要同时重复启动 ALL 和单独服务。

账号同步、扫码登录、草稿保存需要本机连接器：双击 START-CONNECTOR.bat，在显示的本机地址打开授权页面，并在工作台「连接设置」授权和选择这台电脑。若 47821 已被旧连接器占用，先正常退出旧连接器；启动器不会关闭其他实例。

## 命令启动

在 backend 内运行：

```powershell
.\.venv\Scripts\python.exe -X utf8 run.py all
.\.venv\Scripts\python.exe -X utf8 run.py server
.\.venv\Scripts\python.exe -X utf8 run.py connector
.\.venv\Scripts\python.exe -X utf8 run.py mcp
.\.venv\Scripts\python.exe -X utf8 run.py mcp --legacy
.\.venv\Scripts\python.exe -X utf8 run.py check
```

最后两种 MCP 方式分别提供完整业务工具和原 WorkBuddy 三个工具。stdio 客户端应将 command 改为本机 .venv Python 的绝对路径，args 使用 run.py 的绝对路径；示例见 integration/mcp.json。HTTP 入口为 /mcp 和 /mcp/workbuddy，需要已有服务令牌。

Linux/macOS：`python3.13 -m venv .venv`，`.venv/bin/python -m pip install -r requirements.txt`，在 frontend 执行 `pnpm install --frozen-lockfile`，然后 `.venv/bin/python run.py all`。浏览器连接器使用本机已安装的 Chrome，不会要求下载新的平台浏览器。

## 配置与数据

需要自定义时将 .env.example 复制为 .env。默认数据位置为 backend/data/work/grey，配置和相对路径均从 backend 解析，不依赖打开终端的位置。不能删除数据目录、登录配置、模型加密密钥或连接器凭证。

根目录只放 frontend、backend 不会影响上述启动方式。启动脚本、文档、SQL、部署配置都已收进对应目录。隐藏的 .git 是版本记录，请保留。

整理前位于项目根目录的独立数据库和登录目录会整体保存在 backend/data/legacy-root；它们不与默认工作区合并。需要使用那份数据时将 DATA_DIR 设为 `./data/legacy-root`，先按 docs/文件与代码删除指南.md 核对备份。

PostgreSQL：设置 DATABASE_URL 或 DATABASE_URL_FILE 前，必须使用迁移所有者创建既有规范化 schema v2。工具为 tools/migrate_postgres.py，需停掉业务服务和所有任务、完成备份，并显式传入 --offline-confirmed。应用启动不会自动建表、覆盖数据或在 PostgreSQL 失败时切回 SQLite。

## 测试与部署

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -X utf8 -m pytest -q
```

本次验证：后端普通测试 131 项、独立真实 PostgreSQL 16.15 测试 8 项、前端测试 96 项通过；前端构建与本机浏览器/API/配对/WS/MCP 联调通过。PostgreSQL 测试只在显式 TEST_DATABASE_URL 指定的独立回环测试集群运行，不读取应用 DATABASE_URL；未配置时这 8 项会跳过。

容器构建上下文分别为 backend 和 frontend，开发示例为 backend/compose.dev.yaml，生产示例为 compose.prod.example.yaml。Docker 镜像、Windows/Mac 发布安装包和真实平台账号流程仍需分别验收。本次修改未部署到生产，也未调用真实模型供应商或操作真实平台账号。

文件保留与清理规则见 [删除指南](docs/文件与代码删除指南.md)，迁移记录见 [执行记录](docs/migration/ledger.md)。

# Python 全后端迁移设计

用户已确认：主后端、MCP、本机连接器和后台执行代码全部迁移到 Python；前端继续 React。根目录只保留 frontend、backend 两个可见文件夹，隐藏 .git 保留。现有功能、图片数量 1–12、供应商、费用、素材和登录状态受保护。

采用 Python 3.13、FastAPI、Uvicorn、SQLite / psycopg PostgreSQL、Python Playwright、Python MCP SDK。前端接口 URL、JSON 字段、状态码、Cookie、配对协议4和任务状态保持兼容。原 Node 版本及数据已复制到独立本机恢复目录，旧版本 Git 历史保留。

## 目录与职责

- frontend：React 源码、公共前端类型、独立 pnpm 锁文件、Vite、测试、前端 Dockerfile 和 nginx。
- backend/app：FastAPI API、认证、数据服务、模型网关、模板/媒体、配对/WS、MCP、维护服务。
- backend/connector：本机 HTTP 服务、浏览器 CDP、扫码、任务队列、云通道、事件监听、同步与草稿执行。后台实现为 .py；浏览器 DOM 操作表达式可作为 Python 中的字符串传给 Playwright。
- backend/tools：迁移、备份、交付打包、诊断及既有 Python 运维工具。
- backend/tests、docs、sql、deploy：测试、迁移/验收文档、现有 PostgreSQL schema 和部署配置。
- backend/data：原工作目录和本机状态迁入；不进入 Git 或源码 ZIP。
- backend/run.py、START-ALL.bat、START-BACKEND.bat：在任意当前目录可启动；START-ALL 同时启动 Vite 和 Python API并管理退出。

## 公共接口

`app.settings.Settings` 提供 data_dir:Path、database_url:str|None、public_origin:str、service_token:str|None、platform_admin_username:str|None、host:str、port:int、environment:str、trusted_proxy_ips:tuple[str,...]、trust_local_proxy_http:bool、connector_packages_dir:Path|None。

`app.services.Services(settings)` 管理全局认证和租户隔离；`for_workspace(workspace)` 返回独立 Scope（store、creation、publish、studio、templates、models、billing）。API 层依身份选择 workspace，绝不能自动回退到别人的工作区。

数据/业务组件保留现有 payload 和表格式，提供 snake_case 方法；修改状态的操作必须原子化，重复请求和结果未知时禁止重复上传。模型配置兼容 Node AES-256-GCM 的 IV/tag/ciphertext 格式，登录兼容现有 scrypt/bcrypt。

`app.api.create_app(settings=None, services=None)` 创建 FastAPI 应用；`app.main.create_app()` 为 Uvicorn factory。API 迁移以 original-api-contracts.json 的 126 个登记项为依据，重复的 SQLite/PG 认证路径合并，保留语义。

`connector.server.create_connector_app(root:Path, cloud_url:str='', port:int=47821)` 创建本机连接器。`app.protocols` 为 Python 实现的协议4、平台下载映射和增量事件校验，共供 API 与连接器使用。

## 约束与验收

保持登录限速、CSRF、租户隔离、角色限制、HTTPS/受信代理、撤销凭证、媒体路径/SSRF限制、执行设备绑定、任务取消、版本检查和状态未知时禁止重试。媒体清理仍需引用清单和隔离期。

迁移不会调用真实供应商或平台账号；模拟、真实 PostgreSQL、Docker 和 Windows/Mac平台分别记录。禁止以健康接口通过代替任务流程通过，禁止将未实现功能登记为成功，禁止用 Node代理/子进程作为 Python后端兼容层。

先建立核心兼容测试，再实现和检查模块；最终检查接口登记完整性、前端96项回归、Python全套测试、独立启动、HTTP/认证/WS、MCP、纯 Python后台文件清单和原始数据保留证据。真实平台及不可用环境明确记录待验。未通过前保留旧源码恢复包，不删除数据，不上线生产。

# 2026-10-13 前后端分离验证

范围：C:/Users/huake/Desktop/MatrixCloud-Separated。来源为原项目当前工作文件，包含未提交修改；原项目 C:/Users/huake/Desktop/MatrixCloud-Dev 未改动，未连接生产服务。

## 已完成

- frontend/src 和 backend/server 分别存放页面与 API，独立 package.json、TypeScript、Vitest 配置。
- 公共类型提取到 shared/domain.ts、shared/creation.ts，前端不存在 backend 源码导入。
- Express 不再提供前端静态页面；开发 Vite、生产前端 nginx 代理 API、MCP 和 WebSocket。
- 锁文件只调整三个 importer 的依赖归属；依赖解析版本不变。全新副本已通过 pnpm install --frozen-lockfile --offline。
- 根路径、脚本、连接器、打包和迁移路径调整；PowerShell 启动脚本语法检查通过。
- 旧单容器维护发布对分离架构明确拒绝，避免发布一个镜像而漏掉另一个服务；维护检查使用前端专属 Vite 依赖路径。
- 生产代理仅信任明确 IP，开发 HTTP 代理仅在 NODE_ENV=development、TRUST_LOCAL_PROXY_HTTP=1、匹配 loopback PUBLIC_ORIGIN/Host 且来自明确受信代理时允许；生产 HTTPS 保护继续保持。
- 文件与代码删除指南、静态引用关系和逐文件 CSV 已生成，候选代码未自动删除。

## 验证结果

| 检查 | 命令/证据 | 结果 |
|---|---|---|
| 完整构建 | pnpm build | 后端类型检查、前端类型检查及 Vite 构建通过 |
| 前端最新构建 | pnpm --dir frontend build | 独立前端测试配置添加后再次通过 |
| 预检 | pnpm preflight | Node 24.21.0、pnpm 11.25.0，通过 |
| 完整测试 | PYTHON=Python313/python.exe 后 pnpm test | 137 个测试文件通过、1 个文件跳过；491 项通过、9 项跳过，共 500 项 |
| 前端独立测试 | pnpm --dir frontend test | 26 文件、96 项通过 |
| 后端独立配置 | pnpm --dir backend test -- server/__tests__/runtime-paths.test.ts | 1 项通过，工作区根定位正常 |
| 核心回归 | API-only、发布包、代理、开发运输、运行路径测试 | 已先观察失败再修正；相关现有配对/通道测试也通过 |
| PowerShell | System.Management.Automation.Language.Parser.ParseFile | scripts/*.ps1 无语法错误 |
| HTTP/认证/WS smoke | 2026-10-13-proxy-smoke.json | 11 项通过；页面 200，后端 / 为 404，同域 cookie 和操作 API 正常，跨站写入 403，匿名 WS 由后端拒绝 401 |
| 浏览器实际查看 | Codex 内置浏览器访问 http://127.0.0.1:18573/ | 登录页面正常显示，无错误覆盖层；控制台 error/warn 为空 |
| 原源码保留 | SOURCE-SNAPSHOT.json 逐项 SHA-256 | 426 个原始源码文件哈希一致 |

详细终端输出保存在本目录被 Git 忽略的 *.log，验收摘要在此保留。smoke 服务从 frontend/backend 两个工作目录启动，使用独立端口和合成账号，没有生产数据或真实平台调用。临时服务已停止；合成测试数据归入 work/separation-qa-artifacts/。

## 已识别并修正

初始基线的连接器打包测试有 13 项失败，原因是 PATH 默认 Python 3.8.6 不支持既有 removeprefix 用法。指定本机 Python 3.13 后该文件 15 项通过，未为此改业务逻辑。

移动测试后，脚本的 mock 字符串仍指向旧层级；已同步更新并通过现有同步回归。独立前端测试中应用根和测试根混用造成 JSX runtime 解析失败；已分离 frontend/vitest.config.ts，独立测试 96 项通过。

独立代码审查发现：Docker dev 模板的旧 token 太短；维护检查仍用根目录 Vite 路径；Docker dev HTTP 连接器被拒绝。已分别修正 token、CLI 路径和受限的本机开发代理运输规则。运行路径检查另外发现空 SYNC_DATA_DIR 会覆盖 DATA_DIR，已用非空值回退并添加回归。

## 尚未验证

- 本机没有 Docker 命令，两个镜像构建、Compose 实际运行、nginx 语法执行与网关转发仍须在 Docker 环境验收。
- 跳过的 9 项依赖 PostgreSQL 集成测试环境，未宣称已通过真实 PostgreSQL 或数据迁移。
- 未进行真实小红书扫码、内容同步、草稿保存、客户 Windows/Mac 实机平台验收。
- 未上线，未测试生产成对发布/回滚；旧维护发布器需要由受信流程接入双容器发布能力。
- 原始数据、密钥、素材、Profile 和回滚包未复制到源码交付中；正式迁移须按运维和迁移说明进行。

上述待验项不能用单元测试或本机登录页结果替代。

# 迁移执行记录

用户确认迁移全部后端、MCP和连接器到 Python，前端保留 React，根目录仅保留两个可见文件夹。按确认范围连续执行，不额外重复请求范围批准。

原代码、数据和 Git bundle 已备份；位置见 backup-location.txt。旧 Node 后端、连接器、脚本、根目录 workspace 依赖已移到项目外恢复目录，当前实现不调用旧运行代码。原 MatrixCloud-Dev 未改动。

## 当前交付结构

- frontend：独立 React/Vite 工程、contracts、锁文件、测试和静态部署配置。
- backend：Python FastAPI API、MCP、本机连接器、业务/数据服务、维护工具、启动器、SQL、部署配置及文档。
- 根目录只有两个可见文件夹；隐藏 .git 保留。原根目录零散数据完整保存在 backend/data/legacy-root；原 work 整体迁入 backend/data/work。未混合账号或删除原图/登录配置/加密密钥。
- 后端业务代码无 .ts/.js/.mjs 桥接。浏览器 DOM 表达式仍为 Python 字符串。Python Playwright 的上游依赖自带驱动属于第三方运行时；前端开发/编译仍使用 Node。

## 2026-10-13 验证

- 后端完整普通测试：131 passed；当次另有 6 个真实 PostgreSQL 用例因未设置专用 TEST_DATABASE_URL 跳过。数据库用例随后扩展到 8 项并单独实跑全部通过。
- 真实 PostgreSQL 16.15：独立回环集群 50063，8 passed，0 skipped/failures/errors。覆盖规范化 schema v2、最小权限与 RLS、角色/会话/客户停用、成员与媒体顺序/级联/迟到快照、并发领取/Studio 乐观版本/发布证据、AES 配置/模板修订、19 分钟同步租约/终态不覆盖、设备配对/绑定/撤销，以及离线完整迁移和重复迁移保护。JSONB 对象规范化摘要修复已实跑验证。
- PostgreSQL 每项使用随机测试库与非特权应用角色；结束后测试库与角色残留均为 0，临时集群已正常停止。证据：迁移备份的 pg-test-runtime/postgres-validation.json 与 postgres-integration-results.xml。没有读取实际业务数据库。
- 前端：26 个测试文件、96 项测试通过；TypeScript 与 Vite production build 通过。
- 126 个原 API 登记、118 个唯一方法/路径，缺失 0。api-coverage.json 仅证明登记覆盖，不代表每个路径都经过真实平台操作。
- 从项目外工作目录启动 run.py all，API 4174 与 Vite 5173 就绪；Python Playwright 使用本机 Edge 验证 React 创建合成用户、进入工作台与内容空状态，代理 health/operations 均为 200，无页面运行错误。
- 真实本机传输：浏览器 Cookie 授权的一次性配对 → Python 连接器 → Vite WebSocket 代理 → 云通道在线 → RPC verify 成功。只操作合成测试数据。
- 原生 Python MCP SDK 验证 stdio 完整 8 工具与兼容模式 3 工具；经前端代理的 HTTP MCP initialize/tools/list 返回 200 和 8 工具。
- 慢响应头/慢响应体的本机 HTTP 测试验证模型总超时；没有向供应商发送真实请求。
- 独立代码复审后的 38 项针对性测试通过，已修复受信代理、platform-owner 回读、模型总超时、PG 身份字段、ALL 的 TLS 配置冲突、供应商快照与持久同步取消。
- pip check、依赖锁定安装预览、Git diff --check 通过。源文件清单不含 data、.venv、node_modules、真实 .env 或 yingdao.local.json；凭证特征匹配只落在明确的合成拒绝用例。
- QA 证据位于项目外 MatrixCloud-Cleanup-Archive-20261013-154858/python-*-smoke.json；测试运行数据位于迁移备份内。QA 前后端与测试连接器已停止，原项目 47821 连接器未关闭。

## 验证边界

没有部署生产、调用真实模型供应商、扫码真实账号或执行真实同步/草稿发布。Docker 镜像构建、各平台便携安装包、macOS 签名/公证及真实平台流程仍需各自验收。安装包构建工具要求可核对的便携 Python 运行时，当前未生成冒充已验收的新发布包。

历史部署、测试与旧 Node 启动说明只保留于 docs/history，不能作为本次 Python 版本证据。当前启动步骤见 backend/README.md，清理范围见 docs/文件与代码删除指南.md。

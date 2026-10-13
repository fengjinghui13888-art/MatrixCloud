# 矩阵云维护入口

先运行 `node scripts/maintenance-context.mjs`（可加 creation / execution / maintenance），再按需读取验收记录的最新条目。不要重复读取整段历史或整个仓库，只读目标模块和相关差异。

用户最新要求：成本优化仅指 Codex 制作、修复和维护系统时消耗的额度。生图/文案供应商、模型、原有费用设置、洗图二创及已上传素材均受保护；不得为开发降本增加业务预算、收费拦截、生成缓存替代新任务或缩减生图数量。单个创作任务支持1–12张，原有默认值保留。素材库实现、上传数据和原图不纳入本次改动或清理。

- 客户界面：`src/PublishCenter.tsx`、`src/OneClickPublish.tsx`、`src/GreyApp.tsx`；共享样式 `src/styles/workspace-layout.css`。默认图文创作，登录完成后自动同步、审核通过后自动保存草稿，错误经 `customer-message.ts` 转换。
- 执行：`server/studio-routes.ts`、`studio-execution.ts`、`browser-runs.ts`、`xhs-sync.ts`；本机 `local-connector/*`；平台动作 `scripts/studio-executor.mjs`、`xhs-playwright.mjs`。连接器协议4；无新协议保护能力禁止自动任务。用户2026-09-20已明确恢复自动衔接；仍保留取消、限速、账号限制暂停及结果未知时禁止重复上传。
- 开发成本：按模块检索和读取，复用已有依赖、通过的检查及交接记录；一个问题定位一次，只有相关变更才重跑对应检查。不增开重复任务或让多个代理重复读仓库；日志先看摘要和末尾，必要时再读报错上下文。维护MCP自身不调用模型。
- 维护 MCP：`server/maintenance*.ts`，部署说明 `docs/maintenance-mcp.md`。运行服务和受信部署脚本置于源码工作区外。AI不能通过工具自我确认上线。
- 清理：`scripts/release_cleanup.py`、`release_retention.py`、`media-quarantine.py`；PostgreSQL引用快照 `server/media-reference-snapshot.ts`。不删除有效数据、登录目录、密钥或必要回滚；文件变化即跳过。

## 验证与发布

当前生产修复基线为 `a314dbb86f1b26784103501e7f7b19bd0e5d0d79`，工作台地址为 `https://47.106.94.169/`，生产镜像使用 Node 22.14.0。当前交接包见 `outputs/matrix-cloud-release-9e502e4.zip`；验收记录见 `outputs/verification-20260929-cleanup.json`。真实小红书扫码、内容同步和草稿保存仍需使用获授权正常账号在实际浏览器完成，不能仅凭模拟测试声称全流程通过。

三种客户连接器的版本化包及校验值见 `outputs/connectors-current-20260929-signed/`。包内运行时为 Node 22.14.0，配置指向新工作台地址；Mac 包已签名但尚未完成 Apple 公证。Windows 与 Mac 的真实平台验收结果必须单独记录，不得把“连接器在线”写成“账号同步和草稿已通过”。

当前线上记录见 `docs/verification/2026-09-20/security-and-auto-sync.md`；此前基线见 `docs/verification/2026-09-18/production.md`。业务和维护运行代码已部署 `2e42289`，受信部署脚本 `d23f4b2`；公网80只处理ACME/HTTPS跳转，443由独立nginx提供，业务回环4443、维护回环4176。不要重新开8443或让用户操作云防火墙。Mac本机连接器已更新协议4；Windows和真实平台完整流程仍待实测。原生图费用、模型及素材保护边界不变。

云主机 `root@47.106.94.169:22` 使用本机私钥 `/Users/mima0000/.ssh/id_ed25519`，必须显式指定 `-i`、`IdentitiesOnly=yes`、`BatchMode=yes`、`StrictHostKeyChecking=yes`。Docker 命令需要 `sudo -n`。不要输出密钥内容、容器环境或数据库凭证。旧主机只作为迁移回滚参考，不能继续写入生产。

复用已安装依赖。局部修改只运行相关 Vitest 文件及必要的 `tsc -b` / `vite build`；全量 `vitest run --maxWorkers=2 --minWorkers=1` 集中在上线前或跨模块变更时执行。Python部署测试仅在部署脚本变更时执行；媒体测试依赖 requests。每轮在验收记录保存提交、检查命令、结果及待办，通过且无新改动时不重复检查。

真实平台验证只用正常、获授权账号；不使用受限账号。模拟、PostgreSQL、Mac/Windows实机验收分别记录。不能承诺零封禁，也不能用减速伪装或绕过平台限制。

上线必须先展示精确提交、镜像与检查结果，由用户确认。上线后按清单清理并记实际回收字节。云主机/离线设备不可访问时明确记待处理，不能声称全部通过。

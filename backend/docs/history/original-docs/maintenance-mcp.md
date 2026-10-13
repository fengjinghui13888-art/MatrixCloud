# 跨电脑维护 MCP

维护服务入口 `server/maintenance.ts`，独立于业务进程和 `/mcp`。本版仅系统管理员使用；不会自动调用额外模型。

当前已上线：`https://47.106.94.169/maintenance/mcp`。本机 Codex 的 `matrix_maintenance` 已完成真实 OAuth 登录。实际 HTTPS 工具读取、隔离修改、检查、权限拒绝和撤销已通过；ChatGPT 与其他电脑尚未进行真实客户端接入验收。最新版本及证据见 `outputs/verification-20260928-offline-fix.json`；历史记录中的旧地址只用于追溯，不能继续配置。

当前公网443由独立 nginx 接入（`deploy/matrix-ingress.conf`），维护服务保持回环4176，不使用公网8443。业务升级不会关闭维护入口。nginx 用独立内部证书验证回环4443业务服务；证书续期任务完成后 reload nginx，不能把业务改回公网443而不调整入口。代理覆盖客户端转发头，服务显式开启 `TRUST_LOOPBACK_PROXY=1`，不要在未经校验的公开监听上信任所有代理。

当前 systemd 服务以 root 运行固定维护代码，受信部署脚本在源码工作区之外，权限相当于系统管理员；并非无特权服务。系统用户模板可用于另行配置受控提权的安装，但本机没有部署该权限拆分。Git 只信任 `/home/ubuntu/matrix-maintenance-source` 及其 `.git` 精确路径，没有设置全局通配信任。

## 安装前提

需公网可信 HTTPS 地址、云端规范 Git 工作目录、独立服务、Docker、Git、Python 3 和 Node 22.14.0。生产 PostgreSQL 是唯一权威数据源；维护服务不依赖客户连接器的 SQLite 数据。不要直接把业务主令牌当维护凭证。示例配置 `deploy/maintenance-config.example.json` 不含可用密钥。

独立运行环境也可使用经官方 SHA256 验证的 Node 二进制，安装到 `/opt/matrix-maintenance/node/bin/node`；复用依赖时须匹配平台和 libc。安装本机原生模块时使用锁文件中的相同版本与完整性哈希，不重新解析或升级业务依赖。

已有有效证书时，可设置 `MAINTENANCE_TLS_CERT` 和 `MAINTENANCE_TLS_KEY` 直接终止 HTTPS，不依赖业务容器。默认仅监听 `127.0.0.1`；验收并获准启用公网后才设置 `MAINTENANCE_HOST=0.0.0.0`，配置独立端口和对应防火墙规则，`resource` 必须包含准确端口。未配置 TLS 时禁止公开监听。证书每十分钟重新读取，也支持 `SIGHUP`；读取失败保留当前证书。共享现有 IP 证书时不得让维护用户读取业务数据库、登录目录等无关文件。

1. 将已审查的维护运行代码安装到 `/opt/matrix-maintenance/runtime`；将 `scripts/deploy-existing.py`、`scripts/maintenance.py`、`scripts/release_retention.py` 及 `scripts/postgres_backup.py` 安装到只读的 `/opt/matrix-maintenance/trusted`。这些路径不得位于 MCP 修改工作区。部署工具只接收固定容器、镜像摘要和备份路径。
2. 在没有生产凭证的构建目录，用 `deploy/maintenance-checks.Dockerfile` 创建依赖镜像，记录 `docker image inspect` 的精确 ID 和 `pnpm-lock.yaml` 的 SHA256。依赖变化后，管理员须重建检查镜像。测试容器禁止网络、删除 Linux capabilities、只读文件系统、限制 CPU/内存；仅绑定修改源码，未绑定生产数据、Docker socket 或 SSH 密钥。
3. 配置私有 JSON（权限 0600），填入实际路径、依赖镜像 ID、锁文件哈希，以及管理员密码的 scrypt 哈希。使用 `server/maintenance-auth.ts` 的 `passwordHash` 生成，不把密码写进 shell 历史或聊天。维护密码至少 16 字符，建议密码管理器随机生成。
4. 安装 `deploy/matrix-maintenance.service`。维护用户需要运行受控部署脚本及 Docker 的权限；这是管理员权限，不能授给业务租户。
5. 独立域名将所有路径反向代理到 `127.0.0.1:4176`，包含 `/maintenance/*`、`/.well-known/*`、`/authorize`、`/token`、`/revoke`；必须保留外部 Origin。服务拒绝其他 Origin。
6. 登记客户端 ID 和精确回调地址。Codex 的 loopback 端口允许变化，但路径必须相同。未开放任意客户端自注册。ChatGPT 使用其配置页给出的实际回调地址另行登记。

## 使用

Codex 配置示例（预登记客户端）：

```toml
[mcp_servers.matrix_maintenance]
url = "https://47.106.94.169/maintenance/mcp"

[mcp_servers.matrix_maintenance.oauth]
client_id = "matrix-codex"
callback_url = "http://127.0.0.1/callback"
```

然后运行 `codex mcp login matrix_maintenance --scopes maintenance:read` 完成授权。也可以用 `codex mcp add matrix_maintenance --url https://47.106.94.169/maintenance/mcp --oauth-client-id matrix-codex` 添加。配置依据：[OpenAI MCP 官方说明](https://developers.openai.com/zh-Hans/docs/extend/mcp)。客户端需要支持预登记 client_id；不支持时不能绕过鉴权使用业务令牌。先授权 `maintenance:read` 验收读取，确认后分别授予 `maintenance:write`、`maintenance:release`、`maintenance:cleanup`。这台 Mac 已完成添加和登录，不要重复添加或覆盖现有配置；其他电脑需一次客户端登记和管理员登录，不能把本机凭证复制进公共客户安装包。

工具按权限开放项目摘要、源码搜索/读取、修改工作区、文件哈希/补丁/差异、检查、作业状态、发布准备/部署/回滚准备、清理预览/执行。没有任意 shell 工具。

`checks_run` 和 `release_prepare` 返回作业编号，使用 `job_status` 获取结果。发布准备完成后，管理员在独立确认页先验证身份，再审查提交、镜像及差异并确认。确认仅对该版本有效，15 分钟过期且只能使用一次。新增修改、重新检查失败或规范仓库基线改变会拒绝上线。所有操作留有审计记录。部署失败沿用原容器恢复流程；被中断的部署结果标为待核对。

正式部署前必须核对数据库迁移与保留版本兼容。不得在同一次发布删除旧版本依赖的表或字段。首个生产版本及上一验证版本需要登记；当前实现只允许回滚到已登记且成功部署的版本。

ChatGPT 接入：开发者模式中新建 MCP 连接，填写同一 HTTPS URL，OAuth 使用预登记公开客户端 `matrix-chatgpt`，不设置客户端密钥。已登记回调 `https://chatgpt.com/connector_platform_oauth_redirect`，服务发现和回调 `iss` 保持一致，授权码使用 PKCE S256。客户端若给出其他回调，必须先由管理员精确登记，不放宽通配匹配。登记方式见 [OpenAI OAuth 文档](https://developers.openai.com/plugins/build/auth)。能否执行写入取决于客户端和账号开放的能力，模型名称不等于权限，参见[开发者模式权限](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)。本次尚未完成真实 ChatGPT 客户端接入。

## 清理

`cleanup_preview` 仅列本项目可重建目录和过期安装包；`cleanup_apply` 要求一个已验证发布及未过期清单。按哈希复查，变更文件跳过。不会清理源码、客户数据、密钥、浏览器登录目录。

媒体：停止业务服务及执行器，运行 `server/media-reference-snapshot.ts` 从 PostgreSQL 的 note、asset、template、generation 收集引用，活动任务存在时拒绝；清单五分钟有效。用 `scripts/media-quarantine.py quarantine --offline` 隔离三天，再生成全新清单后 `purge --offline`。不要使用历史 SQLite 判断当前 PostgreSQL 引用。在线上传期间禁止媒体回收。

部署脚本健康验收后登记已验证版本，保留当前容器和最近回滚容器；只删除登记过的更旧已停止容器，镜像删除前检查全部容器引用，不使用全局 `docker prune`。业务备份保留最近7天及本次升级前备份，变更的备份跳过。首次遇到未登记的历史资源仅报告待人工登记，不推断其可删。Docker日志配置20MB×3轮换，项目日志按14天策略清理。连接设置提供电脑缓存清理：在线连接器仅清理登记的生成缓存目录，任务运行时拒绝，离线设备返回待处理；不删除登录目录或客户素材。

## 客户连接器交付

最新协议4安装包在 `outputs/connectors-current-20260929-signed/`，下载接口只应发布其中已核验的 Windows、Mac Intel 和 Mac Apple 芯片包。包内运行时为 Node 22.14.0；校验值见同目录清单。向客户交付前仍需完成对应电脑的正常账号验证；协议2/3被拒绝领取自动任务。历史包和旧地址不再作为升级入口。

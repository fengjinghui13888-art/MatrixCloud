# 知序小红书运营台 · WorkBuddy 连接器

本包是面向 WorkBuddy 的 MCP + Skill 连接器配置，需与本项目的 MCP 服务一同部署。它暴露三个工具：

- `get_xhs_operations_overview`：读取账号矩阵、待处理互动与线索摘要；
- `create_xhs_publish_task`：创建草稿或经过明确确认的发布任务；
- `list_xhs_publish_tasks`：查询等待浏览器桥接的任务。

## 本地演示

从本项目根目录启动运营台后，使用 `mcp.json` 中的 stdio 配置：

```bash
pnpm dev
pnpm mcp:workbuddy
```

`mcp:workbuddy` 是 MCP 进程，正常情况下会等待 WorkBuddy 的 stdio 请求；不要把它当作普通命令执行后立即退出。

## 安全与发布规则

- 草稿任务可直接创建，但它只会进入 `awaiting_browser`，不会自动发布。
- 发布任务必须同时包含 `delivery: "publish"` 与 `confirm_publish: true`。
- OpenCLI 和 Chrome 浏览器桥接负责客户本机的页面操作；本连接器不读取 Cookie、密码或浏览器登录态。
- 示例中没有真实令牌。生产部署时需要由知序网站签发客户级服务令牌。

## 生产部署

当前包采用 stdio，是为了快速验证 WorkBuddy 工具发现与调用。网站服务已提供 `/mcp` 的 Streamable HTTP 入口；生产环境使用 `mcp.production.json`，将 `ZHIXU_MCP_URL` 填为你的 HTTPS 地址，将 `ZHIXU_SERVICE_TOKEN` 填为客户级服务令牌，并以 `MCP_SERVICE_TOKEN` 环境变量保护服务端。压缩包仅用于审核连接器元信息与 Skill；生产客户不需要在本机运行这份演示命令。

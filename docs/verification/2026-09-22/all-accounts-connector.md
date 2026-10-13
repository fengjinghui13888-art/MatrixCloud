# 全账号草稿同步与电脑连接修复（2026-09-22）

提交 `c5f0895cc9fd2097fa7da9edad66c8e15afe09ff` 已部署，生产镜像为 `matrix-cloud:all-accounts-c5f0895`，摘要 `sha256:8060f44d316485354797d3bebf6bbbfd324cdc74b25d668b4cf66e3d059bc226`。部署备份为 `/home/ubuntu/matrix-cloud-backups/20260922-all-accounts-c5f0895`。

## 修复内容

- 发布中心不再显示“归属账号”。待审核、待同步和已保存任务的统一按钮现在默认提交当前工作区全部已连接账号；每个账号建立独立草稿任务。需要重新连接的账号会明确提示。结果未知和安全恢复任务仍只允许原任务继续，防止重复上传。
- `127.0.0.1:47821` 是本机连接器地址。旧版未带本机令牌时返回“本机连接器未授权”JSON，容易被误判为连接失败；现在返回清晰的运行状态页、工作台入口和授权提示。连接器启动日志同时区分“云端通道已连接”和“等待工作台授权”。
- 账号矩阵增加“刷新连接状态”按钮，配对完成后可立即重新读取设备与任务通道状态。
- Windows、Mac Intel、Mac Apple 芯片安装包均已重打包，保留已验证 Node 24.21.0；旧包备份在 `/home/ubuntu/matrix-cloud-releases/all-accounts-c5f0895/previous-packages`。

## 验证

- 相关 Vitest：26/26 通过，覆盖全部账号派发、重复点击、未知结果保护、连接器启动和本机地址落地页。
- `tsc -b`、`vite build`、`node --check local-connector/connector.mjs` 通过。
- 公网入口检查 10/10 通过；业务容器运行 `matrix-cloud:all-accounts-c5f0895`，健康接口 200，维护 MCP 匿名 401。
- 线上静态 JS 与本地构建一致，SHA256 `3fe172e20a81bb0898faefe21d9a808bee2e7b230000a095ad4edf135aeb9688`。
- 新安装包本地与云端 SHA256 一致：Windows `f93b7b4b3479421ea2f07b88589b067db1462f8c2e3bbd22f937bf8cd001eca0`；Mac Intel `70811fb9074f27fea22057fa23c349388998ef4e5b0eb525ac6ca09aec6404d7`；Mac Apple 芯片 `987bc2b1129218d2a3047415e6376f885ee8b7376b05027e4e88e3e97d191740`。

本轮没有修改生图、生文案、费用设置、素材库或历史客户数据。真实小红书账号仍需在正常授权账号上完成平台侧草稿验收；本轮修复的是账号目标范围与设备连接确认链路。

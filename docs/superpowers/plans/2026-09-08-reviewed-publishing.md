# 单账号人工发布闭环 Implementation Plan

**Goal:** 在现有 React、Express、SQLite 内接通真实生成、审核、浏览器填充、人工发布与回写；不自动点击发布。

**Architecture:** 发布中心改用独立工作流表，保留历史队列。服务端执行模型请求和版本化审核；本地执行器通过已登录 Chrome Profile 填充，通过受鉴权接口领取与回写。未知发布结果不可重试写入。

**Tech Stack:** 现有 TypeScript / Express / SQLite / React；本机已有 OpenCLI Node 内核。

**Spec:** 本任务用户 23:40 的六项要求。

## 执行顺序（本任务内直接实施）

- [x] server/__tests__/studio.test.ts：先验证未审核不可领取、模型失败保留文本、修改作废审核、重复领取拒绝、补录链接不等于发布成功。
- [x] server/studio.ts：SQLite 持久化生成及审核版本、requestId 去重、领取和回执；已填充只待人工操作，不自动提交。
- [x] server/studio-routes.ts + grey-app.ts：沿用工作区隔离和认证，真实模型生成接口、编辑、审核、领取、回执、补录和异常恢复。
- [x] src/OneClickPublish.tsx：替换旧 WorkBuddy 主入口为创作表单及可编辑审核稿，支持历史恢复和图片预览。
- [x] scripts/studio-executor.ts：固定本地 Profile；诊断、身份核对、读取审核稿、上传、字段回读；不调用现成 publish 命令（其默认动作会发布）。
- [ ] 测试和构建，真实模型最小调用；浏览器如仍不通明确报告断点，不伪造回执。

## 安全约束

- 不变更管理员与密钥，不上传 Cookie，不伪造素材或采集数据。
- 本次不建立评论、私信、曝光采集或 RAG，标明未接入。
- 云端不启动用户浏览器；本机执行器仅执行通过审核的任务。
- 真实公开发布必须由人点击；补录链接维持待确认，需页面核对才能完成。

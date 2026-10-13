# 小红书事件同步 Implementation Plan

> **For agentic workers:** 使用执行计划流程逐项实现并记录测试证据。

**Goal:** 后台识别已登录专属浏览器的新内容/消息事件后，自动增量同步并更新矩阵云。
**Architecture:** 被动浏览器观察器产生去重提示，既有设备WebSocket传递并确认，云端持久化提示、验证绑定并使用原同步队列。页面读取云端状态，采集只由事件或人工动作触发。
**Tech Stack:** Node 22.14、TypeScript、现有ws/playwright-core、React、Vitest；不增加依赖。
**Spec:** docs/superpowers/specs/2026-10-12-event-sync.md

## Global Constraints
- 用户已授权执行与上线，按最新事件触发要求替换3分钟提议。
- 只观察连接器专属profile，不复制普通浏览器凭据，不主动刷新平台。
- 维持协议4原保护，新增event-sync能力明确检测，旧连接器不能启动事件采集。
- 不删除数据、不改费用/模型/素材库；unknown stop、风控暂停和账号校验保留。

## Review Focus
- 跨客户/重绑定/撤销设备事件：拒绝，不能换执行电脑。
- 自己的采集和重复页面响应：不循环发起同步。
- 授权断开/重连/进程重启：待处理提示不丢失，不重新上传发布。
- 已知消息遇新增分页边界：只收录验证归属的新记录，保留覆盖限制。
- 页面关闭/无新事件：不创建周期采集任务，UI不声称平台实时完整。

### Task 1: 事件协议与既有WS传输
Files: shared/xhs-events.mjs; server/connector-channel.ts; local-connector/cloud-channel.mjs; server/__tests__/connector-events.test.ts/js.
Interfaces: channel.onEvent(handler)（返回取消订阅），handler({workspace,deviceId,event}) -> Promise<boolean>；channel.onConnected(handler)；channel.watch(deviceId,subscriptions)；客户端startCloudChannel新增onWatch(subscriptions)，返回stop函数附sendEvent(event)，event-ack通过onEventAck(eventId)。事件为{eventId:UUID,profile:local:ID,kind:notes|comments|messages,fingerprint:64hex}。订阅为{profile,accountId,handle,knownNotes:string[],knownComments:string[],knownMessages:string[]}，带enabled配置。
- [x] 写失败测试，验证绑定拒绝与事件确认。
- [x] 实现传输；ACK只在处理器持久化成功后发。
- [x] 跑定向测试并记录。

### Task 2: 本机被动观察器
Files: local-connector/xhs-watch.mjs; local-connector/connector.mjs; server/__tests__/xhs-watch.test.js.
Interfaces: startXhsWatch({root,getSession,isBusy,onEvent}) -> {setSubscriptions(subscriptions),ack(eventId),close()}。已知ID只作基线；事件outbox按cloud来源隔离。客户端WS watch消息接入观察器；发送失败保留outbox，重连重发；登录/同步时暂停观察事件产生。
- [x] 写无变化不触发、new-ID触发一次、自流量忽略、断线重发失败测试。
- [x] 实现被动网络/通知监听，不导航、不平台轮询。
- [x] 验证现有登录状态直接复用，真实账号依然必须校验双身份。

### Task 3: 云端事件队列与增量采集
Files: server/event-sync.ts; server/grey-app.ts; server/xhs-sync.ts; scripts/xhs-sync.mjs; scripts/remote-sync.mjs; scripts/xhs-playwright.mjs; local-connector/sync-worker.mjs.
Interfaces: /api/event-sync GET/POST{enabled:boolean} => {enabled,mode:'event',accounts:[{accountId,status,message,lastEventAt?,lastSyncedAt?,job?}]}；xhsSync.start增加options参数{mode?:'incremental',source?:'event'}；worker传knownComments/knownMessages和mode，不改变旧默认人工完整同步。
- [x] 测试持久化/授权/无事件不采集/busy合并/unknown暂停。
- [x] 实现安全事件消费，复用scope.run和withExecutionAccess；不增加周期采集。
- [x] 测试评论/私信分页已知ID截止并保留媒体归档、身份校验。

### Task 4: 网页状态与新增提示
Files: src/EventSync.tsx; src/GreyApp.tsx; src/__tests__/event-sync.test.tsx.
接口如Task3；读取云端快照不会读取平台。只在真实入库ID增加后提示新增，删除/分页不能假报新增。
- [x] UI失败测试与开关/状态/新增提示。
- [x] 实现不定时发起平台同步的快照刷新。

### Task 5: 验证与部署
- [x] 所有新增定向测试、现有回归、tsc/vite、连接器语法与全量Vitest。
- [x] 检查最终变更，构建精确候选和Windows连接器，保存校验值。
- [ ] 按已授权部署流程备份、切换、更新安装包与核对线上；记录真实平台待验收项。

## Execution record
用户的“执行任务”已授权实施；随后更正为事件驱动。无需重复询问是否执行。原有dirty修复为已部署基线，保留；只在本任务文件内增量修改。

2026-10-13：最终冻结源码全量验证 132 文件通过、1 文件跳过；484 测试通过、9 测试因真实 PostgreSQL 测试环境缺失跳过；类型检查与前端构建通过。最终源码与 Windows 包已在服务器重建并逐项校验，镜像构建进程 402266 已启动，尚未确认结果。浏览器会话丢失后，阿里云密码验证通过，但已有通行密钥验证连续两次返回浏览器未知异常，线上切换与 owner 事件同步启用均未执行。公网健康检查正常；本机连接器已恢复运行且声明 event-sync 能力。记录：outputs/event-sync-20261013-verification-pending.json。真实平台新事件验收仍待完成。


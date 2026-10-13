---
name: zhixu-xhs-operations
description: 在用户授权下查询小红书账号矩阵，并创建受控的草稿或发布任务。
---

# 知序小红书运营台

先调用 `get_xhs_operations_overview` 获取账号 ID 和待处理互动。只有用户明确要求保存草稿或发布时，才调用 `create_xhs_publish_task`。

## 操作规则

- 默认使用 `delivery: "draft"`，创建后告知用户任务会等待其本机 OpenCLI 浏览器桥接执行。
- `delivery: "publish"` 是高风险操作。必须先在对话中取得用户明确确认，再传入 `confirm_publish: true`。
- 不得编造账号 ID、标题、正文或发布成功回执。
- 若返回“发布任务需要明确确认”，不要重试发布；先向用户确认。
- 需要查看等待执行的工作时，调用 `list_xhs_publish_tasks`。

## 返回解释

任务的 `awaiting_browser` 表示任务已进入知序工作流，但尚未由目标账号已登录的 Chrome Profile 和 OpenCLI Browser Bridge 执行；这不是发布成功。

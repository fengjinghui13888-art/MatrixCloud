# 执行记录

采用独立源码副本，保留原目录的工作修改。仅复制源码和配置模板；数据库、素材、登录状态和私密文件保持在原目录。

方案和计划均按用户明确要求实施，当前会话执行。拆分不包含上线。

Task 1: complete — 目录与依赖配置、公共契约、API-only 测试已完成。
Task 2: complete — 开发/容器/发布/维护路径已调整，已执行本机代理 smoke 和保护测试。
Task 3: complete — 删除指南与逐文件清单已生成，原源码哈希检查通过。
Final review: fresh read-only review; 3 Important findings fixed. No minors.
Ruling: Docker、生产发布/回滚、真实账号、PostgreSQL、业务数据迁移未宣称通过；缺少环境和授权，交付记录保留待验项。
Ruling: 保留工作区 shared/ 和根目录执行工具，因为页面、API、客户连接器共享协议与执行依赖；仅拆两个源码目录不足以保留这些功能。
Final verification: 491 passed, 9 skipped; independent frontend 96 passed; API/auth/WS smoke 11 passed; source hashes 426 unchanged.

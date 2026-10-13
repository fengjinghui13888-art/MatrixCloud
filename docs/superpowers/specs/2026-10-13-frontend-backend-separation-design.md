# 矩阵云前后端分离设计

用户要求：前后端分别放入不同文件夹，提供文件和代码的删除说明。原项目保留，修改只发生于桌面 MatrixCloud-Separated。

采用 pnpm workspace：frontend/src 为 React 页面，backend/server 为 Express API，shared 为双方使用的纯类型和协议。两个子项目有各自的 package.json、TypeScript 和测试配置。根目录提供统一启动、构建、测试命令。保持 Node 22.14.0–24.x、pnpm 11.25.0 和现有依赖锁定版本。

前端不再引用后端文件。domain 和 CreationTask 类型放入 shared，后端重新导出以保持既有调用接口。后端不再提供 dist/index.html；开发由 Vite 代理 /api 和 /mcp，生产由独立前端 nginx 容器提供页面并代理 API 与 WebSocket。浏览器保持同域访问，沿用原认证和 Cookie 行为。

scripts、local-connector、workbuddy-connector、deploy、migration 保留在根目录。修复运行路径、发布包收集规则和维护源码目录规则。旧生产维护流程依赖单容器，应明确阻止它自动发布分离架构；上线必须重新验证双容器发布和回滚。

不改变供应商、价格、默认图片数、1–12 张范围、业务界面文字和任务行为。不复制生产数据、密钥、浏览器登录状态和旧交付包进入源码副本；这些保留在原项目，按受控迁移流程处理。

验收：独立类型检查和构建、前后端测试、真实本机页面及代理/API/认证 smoke 检查、源码哈希对比确认原项目未改动。数据库和真实平台验证须单独说明。删除指南按可再生文件、条件删除、必要源码与受保护数据分类；提供逐文件 CSV，不自动清理业务代码。

# Windows 客户连接器

适用于 Windows 10/11 x64。客户解压 ZIP 后双击 `START-CONNECTOR.bat`，浏览器打开工作台，在“连接设置”完成配对；随后可在账号矩阵中选择电脑并扫码登录。连接器包自带 Node 运行时，不需要安装 Node、pnpm、Python、WSL2 或 Docker。

首次启动会检查运行时、端口和浏览器。Chrome 不在默认路径时会自动探测 Edge；也可以在启动前设置 `CHROME_BIN` 指向浏览器可执行文件。安装路径可以包含空格和中文。

`PAIR-CONNECTOR.bat` 的配对码一次性使用，过期或撤销后需要重新生成；重复点击不会注册旧设备。`install-windows-service.ps1` 可在 PowerShell 5.1 或 7 中创建或更新用户任务，日志写入用户数据目录。

连接器只负责获授权账号的浏览器操作。登录二维码、Cookie、Profile 和平台验证码留在客户电脑上。出现验证码、限流、异常登录、断网或结果未知时，任务会停止并显示下一步，不会盲目重复提交。

源码工作区可运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local-connector.ps1`。启动脚本优先复用当前用户 `.matrix-cloud` 中已有的配对或登录资料；该目录没有既有资料时，保留项目 `work\grey\local-connector` 的既有部署，否则使用用户目录。需要指定目录时传入 `-DataDir "C:\路径\连接器数据"`，也可用 `-Node` 和 `-Port` 指定运行时及端口。脚本从自身位置定位项目，支持路径包含空格和中文。

源码入口在后台启动，并在真实 `/health` 检查通过后报告成功；同一源码及数据目录的兼容实例会直接复用。端口被其他实例占用时会报错，保留现有进程。日志写入所选数据目录的 `logs` 子目录；该入口不会复制、迁移或重新配对既有资料，也不会安装登录自启任务。已有云端配对时，启动会恢复云端任务通道。

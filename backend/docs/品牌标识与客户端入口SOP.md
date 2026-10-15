# HUAKE FUTURE MatrixCloud 品牌与客户端入口

品牌采用黑白 H/M 融合图形。完整英文为 HUAKE FUTURE、MatrixCloud；小尺寸浏览器图标使用简化图形，桌面图标和安装程序使用带英文的方形图标。无需图像生成服务或模型密钥，所有图形均为本项目可编辑的矢量与确定性导出。

## 资源

- frontend/public/brand/logo.svg：系统与后台横向品牌标识。
- frontend/public/brand/mark.svg：浏览器标签图标。
- frontend/public/brand/app-icon.png：512px 完整客户端图标。
- frontend/public/brand/apple-touch-icon.png：Apple 网页收藏图标。
- backend/client/brand/matrixcloud.ico：Windows 原生程序图标。
- backend/client/brand/matrixcloud.icns：Mac 原生程序图标。
- backend/tools/build_brand_assets.py：统一导出脚本，使用 Pillow；不依赖模型调用。修改品牌后从 backend 执行 `.venv\Scripts\python.exe tools/build_brand_assets.py`，再分别构建前端和原生客户端。

客户工作台、登录/密码恢复页面和管理后台共用 BrandLogo 组件。不要分别替换其中某个页面的 Logo。

## 客户端与桌面入口

Windows 安装程序内嵌 ICO、PNG 和连接器初始代码12。首次安装会创建“矩阵云 MatrixCloud”桌面快捷方式，图标来自原生 EXE 资源。普通双击启动会打开配置中 cloudUrl 的客户工作台首页；客户端已运行时，复用现有客户端并再次打开首页。后台自启动使用 --background，不主动打开工作台。

本机现有客户端已换成新品牌启动器，桌面快捷方式指向 backend/data/desktop-client/MatrixCloudClient.exe，并保留原 config.json、账号数据和登录目录。下载入口 outputs/client-releases/installers/windows.exe 已换成新品牌安装包，readiness.json 哈希已同步。Windows 安装包仍为未进行操作系统代码签名的本地验收版本；不要把资源品牌更新当作生产签名完成。

Mac 已提供 ICNS 与使用图标的 PyInstaller 构建代码。必须在目标 Mac 构建 .app，并另行完成 Intel/Apple Silicon、桌面启动、签名及公证验证；本轮没有生成已验证的 Mac 安装包。

## 云服务器部署

部署后使用最终 HTTPS 工作台源地址重新配置并构建客户端，cloudUrl 只能是源地址，不能填写 /admin.html 等路径。浏览器自动打开客户首页，不启动服务器进程；服务器需要持续运行。不能把现在的 127.0.0.1 安装包直接交给云端客户。

客户页面没有平台管理员入口。管理后台仍使用独立 matrix_platform_session 会话，普通客户及客户团队管理员访问管理接口返回拒绝；即使知道 /admin.html，也只能进入独立登录入口，不能读取后台数据。超级管理员与其明确授权的子管理员保留既有权限边界；客户端不携带管理账号、密码或管理会话。

## 本轮验证

相关后端30项通过，覆盖品牌导出、客户首页 URL、拒绝后台路径配置、安装与凭据保留、管理员权限；前端30项通过，TypeScript和生产构建通过。Windows 原生 EXE 已构建，校验图标资源、内置 PNG 与代码12；桌面快捷方式存在且图标目标正确，本机健康检查显示 revision12，下载接口返回200。已在浏览器检查客户和管理后台共用 Logo；Mac 真机未验证。

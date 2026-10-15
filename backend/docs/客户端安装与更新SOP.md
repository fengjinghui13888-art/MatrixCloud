# 矩阵云 SaaS 客户端：安装、更新和验收 SOP

## 同步窗口关闭与复用（2026-10-15）

同步期间关闭账号的小红书页面或浏览器后，采集停止，确认结束后释放任务锁，工作台提示“同步失败：小红书窗口已关闭”，恢复“开始同步”按钮。此前保存的数据保留。扫码期间关闭整个专属浏览器也会结束登录等待；网络断开且尚未确认执行结束时仍需核对，不能把未知状态当成已停止。

同一账号在原执行电脑重新登录时复用原浏览器 profile：已有窗口直接唤起，缺少的平台页面在原浏览器中补齐；浏览器确实关闭后才重开同一账号窗口。换执行电脑仍用新的隔离会话并重新核对身份。

本机签名连接器代码已升级到 revision 12。相关后端43项、前端同步22项测试通过，覆盖关闭窗口中断等待、任务队列释放、按钮恢复、同电脑复用和换电脑隔离。当前真实页面已显示窗口关闭失败提示，开始同步可点击；本次未额外执行真实小红书全量采集或草稿保存。

## 客户操作

1. 在网页注册自己的工作区。
2. 下载本平台客户端。Windows 打开安装 EXE；Mac 打开经过签名、公证的应用安装包。
3. 首次安装界面可选择“登录电脑后自动启动客户端”。客户端内置 Python 和执行依赖，客户不需要自行安装 Python 或解压代码 ZIP。
4. 启动后打开本机连接页，点击授权链接，在工作台确认“授权连接这台电脑”。
5. 选择执行电脑，在客户端打开的独立窗口扫码登录创作后台和小红书网页版，核对一致账号后保存绑定。完整客户端包含执行浏览器，没有 Chrome/Edge 也可使用；已有绑定且登录有效时复用原会话，不重复扫码。客户仍可使用 Safari 浏览工作台。
6. 同步内容；图文审核通过后保存至该电脑的账号专属浏览器草稿箱。正式发布由客户人工操作。

首次安装一次。网页和后端更新由服务端统一完成；客户端定时检查签名代码更新。扫码、同步、草稿执行期间不会重启连接器。新版本健康检查失败会回退旧版本，未确认的升级在电脑重启后同样会回退。开机启动只启动本机客户端，不自动发布内容。

完整客户端构建会从 Playwright 官方发行源准备当前操作系统的 Chromium，再将其与 Python 一起封装；运行和扫码时不下载浏览器。执行浏览器与客户浏览工作台用的浏览器互相独立，账号仍保存在原独立目录中。早期不含浏览器的启动器不能靠代码热更新补出浏览器，需要换装完整客户端，原账号数据目录须保留。Mac 安装包必须在对应架构 Mac 构建、签名、公证和实测，不能拿 Windows 构建代替。

当前 Windows 文件为本地验收版，预设地址 `http://127.0.0.1:5173`，未完成 Authenticode 签名。它不能作为其他客户访问云端的正式安装文件。正式域名确定后重新制作首发安装器；之后普通业务迭代走自动更新。

## 目录和边界

最终补充复验：真实工作区192条线索暴露了逐条读取跟进记录的问题，现已改为一次批量读取并按线索分组，隔离筛选不变。加入192条线索回归后，后端262项通过、1项跳过；四个浏览器页面流程再次全部通过。测试账号与数据均在临时目录，生产账号、平台登录目录及数据库保留。

2026-10-15完整客户端本地验收：Windows AMD64原生EXE已构建，种子代码16，内含Chromium执行浏览器；隔离端口启动后client-state返回revision=16、busy=false。安装包内浏览器文件与官方完整ZIP对应文件SHA-256一致。使用临时账号目录模拟未安装Chrome/Edge，实际启动附带浏览器、重复请求复用进程、关闭后重开同一目录并保留合成Cookie，均通过；未访问小红书。Chrome155、Edge155、Firefox155和WebKit26.6通过工作台与后台记录浏览、线索跟进持久化、1440/820/390宽度检查。后端含独立PostgreSQL测试260项通过，Windows符号链接权限测试1项跳过；前端124项通过并构建成功。此证据不等同于Mac Safari真机、Mac安装包或真实平台同步/草稿的本轮验收，H账号仍保持暂停。

- `frontend/`：网页、下载入口、设备选择、审核与任务展示。
- `backend/app/`：云端 API 和客户数据隔离。
- `backend/connector/`：客户电脑的执行逻辑，可签名热更新。
- `backend/client/`：稳定安装器、启动器、更新校验和失败回退。
- `backend/tools/build_client_release.py`：离线签名发行工具。
- `backend/tools/build_desktop_client.py`：在目标操作系统制作原生客户端。

客户电脑的程序在 `~/.matrix-cloud-client/`，平台登录与设备配对数据在 `~/.matrix-cloud/`。二者分离，更新只新增版本代码目录，不覆盖浏览器 Cookie、平台登录目录或工作台数据。开发者可通过 `--install-root`、`--data-root` 指定隔离验收目录。

安装器/原生运行环境自身升级或依赖 ABI 变更，需要新的基础安装版本。业务代码使用 `python313-connector4-v1` ABI；协议 4 保持兼容。更新器不会下载并执行任意依赖安装命令。

## 构建与发布（维护人员）

所有命令在 backend 内执行，并使用该目录虚拟环境。构建依赖单独安装：

```bash
python -m pip install -r requirements-build.txt
```

初次建立生产更新签名密钥：

```bash
python tools/build_client_release.py --key data/client-signing/production-ed25519.key --generate-key
```

此命令只打印公钥。私钥必须离线保管、备份并限制权限，不能上传 Git、静态站点或打入客户安装器。当前 `development-ed25519.key` 只用于本地验证，不能直接当生产签名密钥部署。

创建发行版本，revision 必须递增，不可覆盖已发布 ZIP：

```bash
python tools/build_client_release.py --key data/client-signing/production-ed25519.key --output outputs/client-releases --revision 1
```

在 Windows 用原生 Windows Python 构建，在 Intel Mac 用 x86_64 Python 构建；PyInstaller 不跨系统生成可执行文件：

```bash
python tools/build_desktop_client.py --releases outputs/client-releases --output outputs/client-builds/release --cloud-url https://你的正式域名 --public-key 公钥十六进制
```

Mac 可额外传入 `--codesign-identity "Developer ID Application: 你的证书身份"`。Mac 签名、公证、打包 DMG 必须在实际 Mac 执行，并检查原生安装与登录流程；本 Windows 环境未完成这些操作。Windows 发行前用有效 Authenticode 证书签名并验证 EXE。不能通过关闭系统安全检查来代替签名验收。

把 Windows 正式客户端放到 `outputs/client-releases/installers/windows.exe`；Intel Mac 放 `mac-intel.dmg`；Apple 芯片 Mac 放 `mac-arm64.dmg`。网页只显示已存在的安装文件，不会给未构建平台生成假下载链接。本地验收文件会标记“未签名”；生产模式不公开这类验收安装文件。

后端通过 `CONNECTOR_CLIENT_RELEASES_DIR` 指向该目录，容器需只读挂载发行文件目录。生产 compose 示例已提供此挂载。更新文件/签名清单由该云端工作台的 HTTPS 同源路径提供：

- `/api/connector/client/manifest`
- `/api/connector/client/packages/<revision>.zip`
- `/api/connector/client/installers/windows.exe`

安装器内固定公钥和工作台地址。网络更新拒绝重定向、外域下载、路径穿越、签名不符、哈希不符、不匹配 ABI/协议和版本降级。签名清单默认有效期 30 天；长期不发布版本时，需要用离线签名密钥续签当前清单，不能让客户依赖过期网络清单。内嵌初始版本不受网络下载有效期限制，仍严格检查签名、内容哈希和首次安装约束。

续签不修改代码或版本，不导致客户重装或重启：

```bash
python tools/build_client_release.py --key data/client-signing/production-ed25519.key --output outputs/client-releases --renew-manifest
```

每次发布先在隔离测试环境完成更新、回退和浏览器任务验收，再把经过审阅的清单和版本文件放入正式发行目录。私钥不必放在 API 服务器。

## 当前本地验收证据

日期：2026-10-14。Windows x64 自包含可执行文件实际安装和运行。

- 合成客户注册成功，真实设备注册和 WebSocket 任务通道连接成功。
- 实际打开 Chrome 扫码窗口，扫码任务忙碌期间新版本只下载等待；停止测试登录后才升级。
- 原生冻结启动器的工作进程实际加载了新增 Python 代码，非只改版本号。
- 无效语法包在安装前被拒绝；可编译但启动失败的版本回退到健康版本；随后正常版本安装成功。
- 版本更新前后设备凭据保持，实际客户 Chrome 登录目录保留。
- 新客户端沿用已核验的 MOYA 登录，合成图片/测试文案实际写入平台草稿箱，任务 `fc524dca-f640-45d9-a6d1-e650451e8fb5` 收到 filled，标题、正文、图片数量与草稿箱唯一条目回读一致。
- 未向平台发布笔记、未发送私信；没有调用付费 AI。模型生成使用合成 transport 回归，真实供应商端到端验收尚未进行。

草稿标题以“客户端验收勿发布”开头，客户可在验收后人工删除。网页草稿存储于执行电脑对应浏览器，与手机草稿不保证互通。

## 上线验收仍需补齐

1. 配置正式 HTTPS 地址，重新构建正式首发安装器并测试远程客户授权、本机访问权限提示和长连接。
2. Windows Authenticode 签名；Intel Mac 原生构建、签名、公证和真实 Safari/Chrome 验收。
3. 在连接设置保存客户自己的模型配置，真实生成一条小红书风格文案和图片，再审核并验证草稿。
4. 在云服务器验证持久化、备份恢复、多客户隔离、代理/WebSocket 和数据库断线恢复。

当前本地证明了安装、授权、自动更新、回退、真实账号读取和草稿保存链路；不据此宣称线上部署或 Mac 实机验收已通过。

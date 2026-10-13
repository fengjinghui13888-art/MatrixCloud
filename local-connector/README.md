# 矩阵云本机连接器

当前为可运行的开发交付版，尚未提供经过签名/公证的 Windows/macOS 客户安装器。客户工作台可用 Safari、Chrome、Edge 或 Firefox 打开；执行电脑上的连接器会自动打开 Chrome 或 Edge 登录窗口，二维码只显示在该窗口中，客户直接在浏览器里扫码即可。客户安装器必须内置运行时和配对窗口，不能让客户自行安装开发环境。

本机模式：`node local-connector/connector.mjs --data-dir "$HOME/.matrix-cloud" --port 47821`

客户首次配对：工作台账号矩阵生成 5 分钟有效的一次性码，然后运行：

`node local-connector/connector.mjs --data-dir "$HOME/.matrix-cloud" --cloud-url "$MATRIX_CLOUD_URL" --pairing-code 12345678`

公网地址只允许 HTTPS。本机调试允许 localhost HTTP。配对文件 cloud-device.json 保存设备凭证，权限 0600；不可分享或提交到版本库。重启只需原来的 data-dir，配对码无需重复输入。

连接器主动向云端建立 WSS 通道并定时发送心跳，无需客户开端口或配置 SSH。每个账号使用独立 Chrome Profile。云端按客户/设备/会话限制可调用的登录、同步及草稿接口，不接受任意脚本、系统命令和回传地址。撤销设备会停止后续请求；已经在平台上保存的草稿不会被撤销操作删除。

已配对设备的浏览器 Cookie 留在本地。请勿复制其他客户的 data-dir；换电脑需要重新配对并扫码。平台网页版草稿保存在执行浏览器内，不保证手机或其他浏览器可见。

本机接口仅监听 127.0.0.1，除 GET /health 外均需本机令牌：GET /verify、POST /accounts/:id/login、GET /accounts/:id/state、GET /accounts/:id/image、POST /accounts/:id/remove、/sync 和 /studio。没有 evaluate 或任意命令接口。

当前通道单响应上限 64 MB；超过上限的单个视频不应显示归档成功。大文件/视频商业交付前需完成 COS 分片直传，避免占用云端进程内存。

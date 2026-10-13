# 发布与交接

## 发布前

1. 确认当前提交、依赖锁文件和 Node/pnpm 版本。
2. 执行 `pnpm install --frozen-lockfile`、`pnpm preflight`、`pnpm build` 和 `pnpm test`。
3. 检查 Dockerfile、Compose、连接器启动脚本和 Windows 路径。
4. 确认生产快照、媒体、密钥和 MCP Token 未进入 Git 或普通包。

## 构建交接包

使用明确的 HTTPS 工作台地址构建，禁止把旧服务器地址写回包内：

```bash
node scripts/build-release.mjs \
  --cloud-url https://your-workbench.example \
  --connector-dir outputs/connectors \
  --output outputs/matrix-cloud-release-<version>
```

脚本生成 `RELEASE-MANIFEST.json`、`checksums.sha256` 和 ZIP。清单记录 Git 提交、依赖版本、构建时间、文件大小和 SHA-256。构建完成后运行：

```bash
node scripts/preflight.mjs outputs/matrix-cloud-release-<version>
```

## 客户连接器

Windows 包为 Windows 10/11 x64，内置 Node 22.14.0；macOS Intel 和 Apple 芯片分别提供包。客户只运行启动入口即可，不安装 Node、pnpm、Python、WSL2 或 Docker。连接器包不包含登录 Cookie、浏览器 Profile 或生产凭证。

## 验收记录

记录 Linux/WSL2 构建、Windows 干净机器启动、Chrome/Edge 探测、路径含空格和中文、配对/撤销/重新配对、内容同步、草稿保存、断网和停止任务结果。无法实际运行的环境单独标记为待验证，不得写成已通过。

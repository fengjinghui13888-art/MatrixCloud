# MatrixCloud · Intel Mac 开发 SOP

交付日期：2026-10-14。前端 React/TypeScript/Vite，后端 Python 3.13/FastAPI，业务数据库 PostgreSQL 16。Node 只用于前端工具链。项目根目录始终只有 `frontend/`、`backend/` 两个业务目录。

## 1. 你收到什么

- `MatrixCloud-IntelMac-source.zip`：当前源码、测试、依赖锁文件、接口约定、部署示例、本手册。可以分享给开发者。
- `MatrixCloud-local-data-private.zip`：本机当前 PostgreSQL 数据快照及必要素材、模型加密密钥。包含登录密码哈希及会话等私有信息，不能发公共仓库。它不是生产云端数据，也不含 Windows 原平台浏览器登录目录。
- `交付校验.json`：版本、文件数量、大小、SHA256、恢复检查结果。

源码包不含 `.git` 历史、`.idea`、虚拟环境、node_modules、dist、Windows PostgreSQL 二进制、旧恢复包或真实 `.env`。新电脑要重新安装依赖和创建数据库连接密码。私有包解压后只出现 `backend/`，合并到项目相同目录即可。

## 2. 环境要求与安装

先在 Mac 终端运行：

```bash
uname -m
sw_vers
xcode-select --install
```

Intel 应显示 `x86_64`。使用原生 Intel 工具链。建议 macOS 15 或更新；较旧系统先确认 Python、Node、Chrome 和 Playwright 的支持情况。2026-10 核对时，Homebrew 已将 Intel 列为 Tier 3，安装可能需要从源码构建，不能保证每一款旧 Mac 都能安装成功。[Homebrew 官方说明](https://docs.brew.sh/Installation)

已有 Homebrew 时：

```bash
brew install python@3.13 node@22 postgresql@16
export PATH="$(brew --prefix python@3.13)/bin:$(brew --prefix node@22)/bin:$(brew --prefix postgresql@16)/bin:$PATH"
python3.13 --version
node --version
pg_dump --version
npm install -g pnpm@11.25.0
pnpm --version
```

把上面 PATH 行添加到 `~/.zshrc`，新终端也生效。期望 Python 3.13.x、Node 22.x、PostgreSQL 16.x、pnpm 11.25.0。不要盲目升级主版本。

若 Homebrew 在 Intel 上失败，使用 [Python 官方 macOS 安装包](https://www.python.org/downloads/macos/)、[Node 官方下载](https://nodejs.org/en/download)、[PostgreSQL 官方 macOS 安装指引](https://www.postgresql.org/download/macosx/) 中适用该机器系统的版本。调整 PATH，确保以上四条版本检查成功后再继续。安装 Chrome 到 `/Applications/Google Chrome.app`。本手册建库部分要求本机能找到 `initdb`、`pg_ctl`、`psql`、`createdb`、`pg_restore`。

## 3. 解压并安装项目依赖（首次）

在 Finder 将源码 ZIP 解压，将得到的 `MatrixCloud-Separated` 放到 `~/Projects/`。然后：

```bash
cd ~/Projects/MatrixCloud-Separated/backend
python3.13 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-dev.txt
python -m pip check

cd ../frontend
pnpm install --frozen-lockfile
```

`requirements-dev.txt` 已包含运行依赖和 pytest；锁文件中的 pywin32 有 Windows 条件，在 Mac 会跳过。Windows 的 `.venv` 和 `node_modules` 不可复制复用。连接器走已安装的原生 Chrome/CDP，常规使用无需下载 Playwright 浏览器；做引擎测试时在后端虚拟环境执行 `python -m playwright install chromium firefox webkit`。WebKit 测试不能代替真实 Safari 验收。

## 4. 初始化独立 PostgreSQL（首次）

以下命令在后端目录运行，创建项目自己的 Mac 数据库集群，监听 127.0.0.1:5433，不与其他项目共用集群。首次执行前确认目录不存在且端口空闲；已有数据库时直接进入第 7 节，不能重复初始化。

```bash
cd ~/Projects/MatrixCloud-Separated/backend
lsof -nP -iTCP:5433 -sTCP:LISTEN
mkdir -p data/postgresql-mac
initdb -D data/postgresql-mac/cluster -U "$(whoami)" --encoding=UTF8 --auth-local=peer --auth-host=scram-sha-256
pg_ctl -D data/postgresql-mac/cluster -l data/postgresql-mac/server.log -o "-h 127.0.0.1 -p 5433 -k /tmp" start
psql -h /tmp -p 5433 -U "$(whoami)" -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE matrix_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
CREATE ROLE matrix_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE DATABASE matrix OWNER matrix_owner;
SQL
psql -h /tmp -p 5433 -U "$(whoami)" -d postgres
```

进入 psql 后运行 `\password matrix_app`，按两次提示设置新的应用密码；用 `\q` 退出。密码不写入 SQL/历史记录。matrix_owner 只做离线建表和恢复，运行 API 使用 matrix_app，保持租户隔离。不要给 matrix_app 超级用户或 BYPASSRLS 权限。

## 5. 数据恢复或空白开发（二选一）

### A. 保留 Windows 当前本地数据

将私有数据包合并解压到 `~/Projects/MatrixCloud-Separated`，确认存在 `backend/transfer/matrix-local.dump` 和 `backend/data/work/grey/`。然后在 backend 中执行：

```bash
pg_restore --list transfer/matrix-local.dump > /tmp/matrix-dump-list.txt
pg_restore -h /tmp -p 5433 -U "$(whoami)" -d matrix --role=matrix_owner --no-owner --no-acl --exit-on-error --single-transaction transfer/matrix-local.dump
psql -h /tmp -p 5433 -U "$(whoami)" -d matrix -v ON_ERROR_STOP=1 -f sql/003-interaction-leads.sql
psql -h /tmp -p 5433 -U "$(whoami)" -d matrix -v ON_ERROR_STOP=1 -f sql/mac-app-permissions.sql
```

仅恢复到刚创建的空数据库。已有数据时先备份，不能使用 `--clean` 覆盖。自定义 dump 可跨架构恢复，不能把 Windows cluster 文件夹当作 Mac 集群。[PostgreSQL 恢复说明](https://www.postgresql.org/docs/16/app-pgrestore.html)

快照保留当前本地测试账号、测试内容与素材；原账号密码沿用。本包未附明文密码，忘记测试密码可在页面新建账号。Windows 已登录的平台浏览器会话不复制；Mac 连接器要重新授权和扫码。数据库里的旧设备绑定可能仍显示离线，应在对应工作区重新选择 Mac 设备。事件日志和临时执行锁没有搬迁，避免旧任务状态被当成仍在运行。

### B. 不需要旧本地数据，空白开发

不解压私有数据包。在 backend 执行：

```bash
psql -h /tmp -p 5433 -U "$(whoami)" -d matrix -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE matrix_owner;
\i sql/postgres-schema.sql
SQL
psql -h /tmp -p 5433 -U "$(whoami)" -d matrix -v ON_ERROR_STOP=1 -f sql/mac-app-permissions.sql
```

启动后通过页面注册。不要对恢复后的数据库再次执行 SQLite 迁移脚本。

## 6. 配置后端（首次）

在 backend 中激活 `.venv`，执行以下命令；提示时输入第 4 节设置的 matrix_app 密码：

```bash
source .venv/bin/activate
python - <<'PY'
from pathlib import Path
from getpass import getpass
from urllib.parse import quote
p = Path('data/postgresql/app-url')
if p.exists() or Path('.env').exists():
    raise SystemExit('已有连接配置，请手工核对，拒绝覆盖')
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text('postgresql://matrix_app:' + quote(getpass('matrix_app 密码: '), safe='') + '@127.0.0.1:5433/matrix', encoding='utf-8')
p.chmod(0o600)
Path('.env').write_text(Path('.env.example').read_text(encoding='utf-8'), encoding='utf-8')
Path('.env').chmod(0o600)
print('配置已写入，密码未显示')
PY
```

确认 `.env` 使用 `DATABASE_REQUIRED=true`、`DATABASE_URL_FILE=./data/postgresql/app-url`、`LOCAL_POSTGRES=false`、`DATA_DIR=./data/work/grey`。Mac 数据库由本手册的 pg_ctl 启动；原有 Windows 自动启动器不可用于 Mac 集群。前端只知道 API 地址，不放数据库密码、模型 API Key 或 MCP Token。避免 IDE 环境变量里的旧 DATABASE_URL 覆盖文件配置。

## 7. 日常启动与关闭

首次建库完成后，每次重启电脑按以下顺序操作。

**数据库终端：**

```bash
cd ~/Projects/MatrixCloud-Separated/backend
pg_ctl -D data/postgresql-mac/cluster status
# 若未运行：
pg_ctl -D data/postgresql-mac/cluster -l data/postgresql-mac/server.log -o "-h 127.0.0.1 -p 5433 -k /tmp" start
```

**后端终端：**

```bash
cd ~/Projects/MatrixCloud-Separated/backend
source .venv/bin/activate
python run.py server
```

**前端独立终端：**

```bash
cd ~/Projects/MatrixCloud-Separated/frontend
pnpm dev
```

Chrome 打开 <http://127.0.0.1:5173/>。API 在 4174、数据库在 5433。使用一致的 127.0.0.1 地址，避免 localhost 混用影响授权。两个服务保持运行。前后端分别 Ctrl+C 关闭；之后需要关闭数据库时执行 `pg_ctl -D data/postgresql-mac/cluster stop -m fast`。

首次安装完成后也可在 backend 执行 `python run.py all --no-open` 同时管理两个服务；这仍然是独立的前端/后端进程。不要同时运行 all 和上面的独立启动命令，以免端口重复占用。

**需要账号同步/平台扫码/草稿执行时，第三个终端：**

```bash
cd ~/Projects/MatrixCloud-Separated/backend
source .venv/bin/activate
python run.py connector --cloud-url http://127.0.0.1:5173
```

在工作台“账号矩阵”授权本电脑，再扫码平台。连接器监听本机 47821。工作台可用 Safari，执行连接器仍使用 Chrome/Edge。真实 AI 生成需在“连接设置”保存你的供应商/模型配置；包内没有供应商密钥，不表示真实供应商或平台发布已经验收。

## 8. IDE 运行设置

打开 `MatrixCloud-Separated` 作为项目。Python 解释器选择 `backend/.venv/bin/python`；后端脚本为 `backend/run.py`，参数 `server`，工作目录 `backend`。前端运行配置为 `pnpm dev`，工作目录 `frontend`。不要在根目录创建第二份虚拟环境。Mac 不使用 Windows `.bat` 文件。

## 9. 开发与验收

后端终端：

```bash
cd ~/Projects/MatrixCloud-Separated/backend
source .venv/bin/activate
python -m pip check
python -m pytest -q
curl -f http://127.0.0.1:4174/api/health
```

前端终端：

```bash
cd ~/Projects/MatrixCloud-Separated/frontend
pnpm test
pnpm build
curl -f http://127.0.0.1:5173/api/health
```

健康检查应显示 `storage: postgresql`、`schema: 2`。普通 pytest 会跳过需要专门 TEST_DATABASE_URL 的 PG 集成测试；不得把跳过当成 PG 测试已通过。不要把开发或生产数据库当作测试数据库。

浏览器验收：在 Mac 的 Chrome 和真实 Safari 分别检查注册/登录、七个菜单页、内容搜索、素材上传、评论转线索、跟进保存、刷新后会话、注销、窄屏对话框。连接器授权要在已打开页面重复进入授权链接，确认路由正确。真实平台扫码/同步/草稿另验，发布前核对目标账号和内容。

本交付在 Windows 校验 ZIP、源码及数据库实际恢复；无法在此机确认 Intel Mac 安装和真实 Safari 行为。之前的 Windows Chrome/Edge/Firefox/WebKit 证据不替代上述 Mac 实机验收。

## 10. 常见故障

| 现象 | 操作 |
|---|---|
| 5173/4174 被占用 | `lsof -nP -iTCP:5173 -sTCP:LISTEN` 或改查 4174；确认是本项目后关闭旧终端，再启动。已有页面能用就无需重复启动。 |
| 数据库连接拒绝 | 确认 pg_ctl status、5433 监听、.env 的 LOCAL_POSTGRES=false 和连接文件；不要回退 SQLite。 |
| 密码认证失败 | 确认 matrix_app 密码与 app-url 一致，特殊字符必须 URL 编码；不要用管理员账号代替。 |
| 缺表/schema 2 错误 | 确认完成第 5 节恢复或初始化，连接到了 matrix 数据库。 |
| permission denied / RLS | 运行 mac-app-permissions.sql；检查 matrix_app 不是超级用户，不要关闭 RLS。 |
| 前端 npm 警告 | 本项目使用 pnpm，不用 npm 安装依赖。 |
| 找不到 Chrome | 安装到 /Applications；特殊路径可在 backend/.env 设置 MATRIX_CHROME_PATH。 |
| pip 无可用 Intel wheel | 核对 macOS/Python 3.13/x86_64 和软件包支持情况；保存完整错误，不随意改业务依赖版本。 |
| 恢复后素材打不开 | 确认私有包的 template-uploads 与数据库快照同时搬迁，DATA_DIR 正确。 |

## 11. 备份、Git 与可删除文件

数据库用 `pg_dump`，素材与模型加密密钥一起备份。连接器浏览器目录另行本机保管，不与团队共享。

```bash
cd ~/Projects/MatrixCloud-Separated/backend
mkdir -p data/backups
pg_dump -h /tmp -p 5433 -U "$(whoami)" -d matrix -Fc --no-owner --no-acl -f "data/backups/matrix-$(date +%Y%m%d-%H%M%S).dump"
```

源码包没有 Git 历史，新机器可在根目录 `git init`，创建本地开发基线。同步已有 GitHub 仓库前先 fetch、比较差异，不能盲目强制推送；当前交付以校验清单列出的本机提交为准，不依赖远端是否已收到最新代码。

可重建：frontend/node_modules、frontend/dist、backend/.venv、__pycache__、.pytest_cache、IDE 配置。它们不进 Git。

不可随意删除：frontend 的 src/、contracts/、public/、package.json、pnpm-lock.yaml、构建配置；backend 的 app/、connector/、tools/、sql/、tests/、integration/、requirements*.txt、run.py；实际数据、模板原图、model-encryption-key、.env、连接凭据、有效备份。测试与接口文件是后续维护依据，不属于无用代码。

项目根只保留两个业务目录；允许 Git 自动产生隐藏 `.git`。私有包恢复完成并校验后，`backend/transfer` 可以移到你的备份盘，不必长期留在工作目录。不能只备份 dump 而丢失模型加密密钥及上传素材。不要提交 `.env`、data/、transfer/ 或私有 ZIP。

"""Separate maintenance state, PKCE OAuth and reviewed source changes.

The legacy single-container publisher remains blocked for this separated build.
No MCP tool can grant its own release approval.
"""
from __future__ import annotations
import asyncio
import base64
from contextlib import asynccontextmanager, contextmanager
import hashlib
import hmac
import html
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import threading
import time
import uuid
from urllib.parse import urlencode, urlsplit, urlunsplit, parse_qs
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, HTMLResponse, RedirectResponse, Response
from .gateway import ConnectorError, digest, stamp
from .mcp_server import text_result, schema, string, HttpTransport
from mcp.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.types import Tool, ListToolsResult, ToolAnnotations

SCOPES = ['maintenance:read', 'maintenance:write', 'maintenance:release', 'maintenance:cleanup']


def password_hash(password):
    if len(password) < 16:
        raise ValueError('维护密码至少16个字符')
    salt = secrets.token_hex(16)
    return salt + ':' + hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32).hex()


def password_matches(password, stored):
    try:
        salt, expected = stored.split(':')
        actual = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32)
        return hmac.compare_digest(actual, bytes.fromhex(expected))
    except (ValueError, TypeError):
        return False


class MaintenanceState:
    def __init__(self, root):
        root = Path(root)
        root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(root / 'maintenance.sqlite', check_same_thread=False)
        self.db.execute('CREATE TABLE IF NOT EXISTS item(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id))')
        self.db.commit()

    def get(self, kind, identifier):
        with self.lock:
            row = self.db.execute('SELECT payload FROM item WHERE kind=? AND id=?', (kind, identifier)).fetchone()
            return json.loads(row[0]) if row else None

    def list(self, kind):
        with self.lock:
            return [json.loads(r[0]) for r in self.db.execute('SELECT payload FROM item WHERE kind=? ORDER BY rowid DESC LIMIT 1000', (kind,))]

    def put(self, kind, identifier, value):
        with self.lock, self.db:
            self.db.execute('INSERT INTO item VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload', (kind, identifier, json.dumps(value, ensure_ascii=False)))

    def remove(self, kind, identifier):
        with self.lock, self.db:
            self.db.execute('DELETE FROM item WHERE kind=? AND id=?', (kind, identifier))

    def audit(self, actor, action, target, result):
        identifier = str(uuid.uuid4())
        self.put('audit', identifier, dict(id=identifier, actor=actor, action=action, target=target, result=result, at=stamp()))

    @contextmanager
    def exclusive(self, identifier):
        try:
            with self.lock, self.db:
                self.db.execute("INSERT INTO item VALUES('lock',?,'{}')", (identifier,))
        except sqlite3.IntegrityError:
            raise ValueError('该操作正在执行或尚未核对上次结果')
        try:
            yield
        finally:
            self.remove('lock', identifier)

    def prune(self):
        with self.lock, self.db:
            self.db.execute("DELETE FROM item WHERE kind IN ('pending','code','approval-form') AND json_extract(payload,'$.expires')<?", (int(time.time() * 1000),))


class MaintenanceAuth:
    def __init__(self, config):
        self.config = config
        self.state = MaintenanceState(config['stateRoot'])
        self.resource = config['resource']

    def begin(self, params):
        self.state.prune()
        client = next((c for c in self.config['clients'] if c['client_id'] == params.get('client_id')), None)
        redirect = params.get('redirect_uri', '')
        actual = urlsplit(redirect)
        valid_redirect = client and any(uri == redirect or (urlsplit(uri).scheme == actual.scheme == 'http' and urlsplit(uri).hostname == actual.hostname == '127.0.0.1' and urlsplit(uri).path == actual.path and not actual.query and not actual.fragment and not actual.username and not actual.password) for uri in client['redirect_uris'])
        if not valid_redirect or params.get('resource') != self.resource or params.get('code_challenge_method') != 'S256' or not re.fullmatch(r'[\w-]{43,128}', params.get('code_challenge', '')):
            raise ConnectorError(400, '授权客户端、回调或资源无效')
        scopes = params.get('scope', 'maintenance:read').split()
        if any(scope not in SCOPES for scope in scopes):
            raise ConnectorError(400, '权限范围无效')
        if len(self.state.list('pending')) >= 200:
            raise ConnectorError(429, '授权请求过多，请稍后重试')
        pending = dict(id=secrets.token_urlsafe(32), clientId=client['client_id'], redirectUri=redirect, scopes=scopes, challenge=params['code_challenge'], resource=self.resource, expires=int(time.time() * 1000) + 300000, state=params.get('state'))
        self.state.put('pending', digest(pending['id']), pending)
        return pending

    def pending(self, identifier):
        value = self.state.get('pending', digest(identifier))
        if not value or value['expires'] < time.time() * 1000:
            raise ConnectorError(400, '授权请求已过期')
        return value

    def consent(self, identifier, password):
        pending = self.pending(identifier)
        if not password_matches(password, self.config['adminHash']):
            self.state.audit('unknown', 'oauth-login', pending['clientId'], 'denied')
            raise ConnectorError(403, '管理员验证失败')
        code = secrets.token_urlsafe(32)
        with self.state.exclusive('consent:' + digest(identifier)):
            pending = self.pending(identifier)
            self.state.remove('pending', digest(identifier))
            self.state.put('code', digest(code), pending)
        self.state.audit('owner', 'oauth-consent', pending['clientId'], ' '.join(pending['scopes']))
        url = urlsplit(pending['redirectUri'])
        query = parse_qs(url.query)
        query.update(code=[code], iss=[urlsplit(self.resource).scheme + '://' + urlsplit(self.resource).netloc + '/'])
        if pending.get('state'):
            query['state'] = [pending['state']]
        return urlunsplit((url.scheme, url.netloc, url.path, urlencode(query, doseq=True), url.fragment))

    def issue(self, client, scopes, family):
        access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.state.put('access', digest(access), dict(clientId=client, scopes=scopes, expiresAt=int(time.time()) + 900, resource=self.resource, extra=dict(actor='owner', family=family)))
        self.state.put('refresh', digest(refresh), dict(clientId=client, scopes=scopes, family=family, expires=int(time.time() * 1000) + 7 * 86400000))
        return dict(access_token=access, refresh_token=refresh, token_type='Bearer', expires_in=900, scope=' '.join(scopes))

    def exchange(self, params):
        client = params.get('client_id')
        if not any(c['client_id'] == client for c in self.config['clients']):
            raise ConnectorError(400, '授权客户端无效')
        if params.get('resource') != self.resource:
            raise ConnectorError(400, '授权资源无效')
        kind = params.get('grant_type')
        token = params.get('code') if kind == 'authorization_code' else params.get('refresh_token')
        if not token:
            raise ConnectorError(400, '授权凭证无效')
        with self.state.exclusive('exchange:' + digest(token)):
            pending = self.state.get('code' if kind == 'authorization_code' else 'refresh', digest(token))
            if not pending or pending['clientId'] != client or pending['expires'] < time.time() * 1000:
                raise ConnectorError(400, '授权码或刷新凭证无效')
            if kind == 'authorization_code':
                challenge = base64.urlsafe_b64encode(hashlib.sha256(params.get('code_verifier', '').encode()).digest()).decode().rstrip('=')
                if pending['redirectUri'] != params.get('redirect_uri') or not hmac.compare_digest(challenge, pending['challenge']):
                    raise ConnectorError(400, '授权码或PKCE校验失败')
                family, scopes = str(uuid.uuid4()), pending['scopes']
                self.state.remove('code', digest(token))
            elif kind == 'refresh_token':
                if self.state.get('revoked', pending['family']):
                    raise ConnectorError(400, '刷新凭证无效')
                scopes = params.get('scope', ' '.join(pending['scopes'])).split()
                if any(scope not in pending['scopes'] for scope in scopes):
                    raise ConnectorError(400, '不能扩大权限')
                family = pending['family']
                self.state.remove('refresh', digest(token))
            else:
                raise ConnectorError(400, '不支持的授权类型')
            return self.issue(client, scopes, family)

    def verify(self, token):
        value = self.state.get('access', digest(token))
        if not value or value['expiresAt'] < time.time() or self.state.get('revoked', value['extra']['family']):
            raise ConnectorError(401, 'Token expired or revoked')
        return value

    def revoke(self, client, token):
        value = self.state.get('access', digest(token)) or self.state.get('refresh', digest(token))
        if value and value['clientId'] == client:
            family = value.get('extra', {}).get('family', value.get('family'))
            self.state.put('revoked', family, {'at': time.time()})
            self.state.audit('owner', 'oauth-revoke', client, 'revoked')


def source_path(root, name):
    root = Path(root).resolve()
    allowed_roots = ('backend/app/', 'backend/connector/', 'backend/tests/', 'backend/tools/', 'backend/docs/', 'backend/sql/', 'backend/deploy/', 'frontend/src/', 'frontend/public/')
    allowed_files = {'backend/requirements.txt', 'backend/Dockerfile', 'backend/.dockerignore', 'backend/run.py', 'backend/START-ALL.bat', 'backend/START-BACKEND.bat', 'frontend/package.json', 'frontend/pnpm-lock.yaml', 'frontend/Dockerfile', 'frontend/.dockerignore', 'frontend/vite.config.ts', 'frontend/vitest.config.ts', 'frontend/tsconfig.json', 'frontend/tsconfig.app.json', 'frontend/tsconfig.node.json', 'frontend/index.html', 'backend/AGENTS.md'}
    if not name or len(name) > 300 or '\\' in name or any(not part or part in ('.', '..') or part.startswith('.') for part in name.split('/')) and name not in allowed_files or not (name.startswith(allowed_roots) or name in allowed_files) or re.search(r'\.(pem|key|sqlite|db|enc|log|dump|zip|local\.json)$', name, re.I):
        raise ValueError('只允许项目源码路径')
    current = root
    for part in name.split('/'):
        current /= part
        if current.is_symlink() or current.is_junction():
            raise ValueError('源码路径不能包含符号链接')
    if not current.resolve().is_relative_to(root):
        raise ValueError('源码路径越界')
    return current


def git(root, *args):
    result = subprocess.run(['git', '-c', 'core.hooksPath=' + os.devnull, '-C', str(root), *args], capture_output=True, text=True, timeout=30, check=True)
    if len(result.stdout.encode()) > 2 * 1024 * 1024:
        raise ValueError('结果过大，请缩小查询')
    return result.stdout.strip()


class MaintenanceService:
    def __init__(self, config):
        self.config, self.root = config, Path(config['repoRoot']).resolve()
        state_root = Path(config['stateRoot']).resolve()
        if state_root.is_relative_to(self.root):
            raise ValueError('维护状态必须保存在源码目录之外')
        self.state = MaintenanceState(state_root)
        self.tasks = set()

    def change(self, identifier):
        value = self.state.get('change', identifier)
        if not value:
            raise ValueError('修改工作区不存在')
        return value

    def context(self):
        return dict(revision=git(self.root, 'rev-parse', 'HEAD'), changes=[{k: v for k, v in c.items() if k != 'directory'} for c in self.state.list('change')[:20]], releases=self.state.list('release')[:10], jobs=self.state.list('job')[:10], policy=dict(deploy='分离版须审查精确前后端两镜像并人工确认；旧单容器发布器已阻止', rollbackVersions=1, quarantineDays=3), guide='先读 backend/AGENTS.md 和当前状态，按需读取文件；请勿重复拉取完整日志。')

    def read_source(self, name, start=1, lines=100, change_id=None):
        root = Path(self.change(change_id)['directory']) if change_id else self.root
        path = source_path(root, name)
        if not git(root, 'ls-files', '--', name):
            raise ValueError('文件未纳入源码版本')
        if path.stat().st_size > 256000:
            raise ValueError('文件过大，请使用搜索')
        return '\n'.join(f'{index + start}: {line}' for index, line in enumerate(path.read_text(encoding='utf-8').splitlines()[max(0, start - 1):max(0, start - 1) + min(200, max(1, lines))]))

    def search_source(self, query):
        if not query or len(query) > 200:
            raise ValueError('搜索内容长度无效')
        try:
            output = git(self.root, 'grep', '-n', '-I', '-F', '-e', query, '--', 'backend', 'frontend')
        except subprocess.CalledProcessError as error:
            if error.returncode == 1:
                return ''
            raise ValueError('搜索失败或结果过大，请缩小查询')
        result = []
        for line in output.splitlines():
            try:
                source_path(self.root, line.split(':')[0])
                result.append(line)
            except ValueError:
                pass
        return '\n'.join(result[:50])

    def create_change(self, base):
        if not re.fullmatch(r'[a-f0-9]{40}', base) or git(self.root, 'rev-parse', 'HEAD') != base:
            raise ValueError('基线已改变，请重新读取项目状态')
        identifier = str(uuid.uuid4())
        directory = Path(self.config['stateRoot']) / 'changes' / identifier
        directory.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', 'clone', '--quiet', '--no-hardlinks', '--', str(self.root), str(directory)], check=True, capture_output=True, timeout=30)
        git(directory, 'checkout', '--detach', base)
        self.state.put('change', identifier, dict(id=identifier, base=base, directory=str(directory), commit=base, createdAt=stamp()))
        return dict(id=identifier, commit=base)

    def file_hash(self, identifier, name):
        path = source_path(self.change(identifier)['directory'], name)
        return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None

    def apply_patch(self, identifier, name, content, expected_hash):
        with self.state.exclusive('change:' + identifier):
            change = self.change(identifier)
            if len(content.encode()) > 256000 or self.file_hash(identifier, name) != expected_hash:
                raise ValueError('文件已改变或补丁过大，请重新读取后修改')
            path = source_path(change['directory'], name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding='utf-8')
            git(change['directory'], 'add', '--', name)
            if git(change['directory'], 'diff', '--cached', '--stat'):
                git(change['directory'], '-c', 'user.name=Matrix Maintenance', '-c', 'user.email=maintenance@localhost', 'commit', '-m', 'maintenance: update ' + name)
            change['commit'] = git(change['directory'], 'rev-parse', 'HEAD')
            change.pop('checked', None)
            self.state.put('change', identifier, change)
            return dict(id=identifier, commit=change['commit'], fileHash=self.file_hash(identifier, name))

    def diff(self, identifier, offset=0):
        change = self.change(identifier)
        return git(change['directory'], 'diff', '--no-ext-diff', change['base'], 'HEAD', '--', 'backend', 'frontend')[offset:offset + 32000]

    async def run_checks(self, identifier):
        with self.state.exclusive('change:' + identifier):
            change = self.change(identifier)
            commit = git(change['directory'], 'rev-parse', 'HEAD')
            image = self.config.get('checksImage', '')
            if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
                raise ValueError('维护运行环境配置无效')
            requirements = Path(change['directory']) / 'backend/requirements.txt'
            if self.config.get('lockHash') != hashlib.sha256(requirements.read_bytes()).hexdigest():
                raise ValueError('依赖锁文件变化，需要管理员重建并登记隔离检查镜像')
            command = ['docker', 'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=2g', '--cpus=2', '--tmpfs=/tmp:rw,size=512m,mode=1777', '--mount', 'type=bind,source=' + str(Path(change['directory']).resolve()) + ',target=/input,readonly', '--entrypoint=/bin/sh', image, '-c', 'mkdir /tmp/check && cp -R /input/. /tmp/check/ && cd /tmp/check && PYTHONPATH=backend python -m pytest backend/tests -q && cd frontend && pnpm exec tsc -b && pnpm test --run && pnpm run build']
            process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env={'PATH': os.environ.get('PATH', ''), 'DOCKER_CONFIG': '/nonexistent'})
            output, _ = await asyncio.wait_for(process.communicate(), 1200)
            passed = process.returncode == 0 and git(change['directory'], 'rev-parse', 'HEAD') == commit
            if passed:
                change['checked'] = commit
            else:
                change.pop('checked', None)
            self.state.put('change', identifier, change)
            summary = re.sub(r'(Bearer\s+|api[_-]?key[=:]\s*)\S+', '[凭证省略]', output.decode(errors='replace')[-16000:], flags=re.I)
            return dict(ok=passed, summary=summary)

    async def prepare_release(self, identifier):
        raise ValueError('前后端分离版本须使用双容器部署与回滚流程；旧维护发布器不能执行该操作。须审查精确两镜像再人工批准。')

    async def deploy_release(self, identifier):
        raise ValueError('前后端分离版本须使用双容器部署与回滚流程；旧维护发布器不能执行该操作')

    def prepare_rollback(self, identifier):
        raise ValueError('前后端分离版本须使用双容器部署与回滚流程；旧维护发布器不能执行该操作')

    def approve_release(self, identifier, actor):
        release = self.state.get('release', identifier)
        if actor != 'owner' or not release or release['status'] != 'prepared':
            raise ValueError('版本已改变或不能确认')
        change = self.change(release['changeId'])
        if git(change['directory'], 'rev-parse', 'HEAD') != release['commit'] or change.get('checked') != release['commit']:
            raise ValueError('版本已改变或不能确认')
        release['approval'] = dict(actor=actor, expires=time.time() * 1000 + 900000)
        self.state.put('release', identifier, release)

    def submit_job(self, operation, function):
        identifier = str(uuid.uuid4())
        self.state.put('job', identifier, dict(id=identifier, operation=operation, status='running', createdAt=stamp()))
        async def execute():
            try:
                value = function()
                if hasattr(value, '__await__'):
                    value = await value
                self.state.put('job', identifier, dict(id=identifier, operation=operation, status='completed', result=value))
            except Exception as error:
                self.state.put('job', identifier, dict(id=identifier, operation=operation, status='failed', message=str(error)[:500]))
        task = asyncio.create_task(execute())
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return dict(id=identifier, status='running')

    def job(self, identifier):
        value = self.state.get('job', identifier)
        if not value:
            raise ValueError('作业不存在')
        return value

    def cleanup_preview(self):
        files = []
        for prefix, days in [('frontend/dist', 0), ('frontend/.vite', 0), ('backend/outputs', 7), ('backend/service-logs', 14)]:
            directory = self.root / prefix
            if not directory.exists() or directory.is_symlink():
                continue
            for file in directory.rglob('*'):
                if file.is_symlink() or not file.is_file() or any(p.is_symlink() for p in file.parents if p.is_relative_to(self.root)):
                    continue
                if time.time() - file.stat().st_mtime < days * 86400 or prefix.endswith('outputs') and file.suffix not in ('.zip', '.gz', '.tmp') or prefix.endswith('service-logs') and file.suffix != '.log':
                    continue
                files.append(dict(path=file.relative_to(self.root).as_posix(), bytes=file.stat().st_size, sha256=hashlib.sha256(file.read_bytes()).hexdigest()))
        identifier = str(uuid.uuid4())
        plan = dict(id=identifier, createdAt=time.time() * 1000, files=files, bytes=sum(item['bytes'] for item in files))
        self.state.put('cleanup', identifier, plan)
        return plan

    def cleanup_apply(self, manifest, release_id):
        release = self.state.get('release', release_id)
        if not release or release['status'] != 'deployed':
            raise ValueError('必须先完成已验证发布')
        plan = self.state.get('cleanup', manifest)
        if not plan or plan.get('executed') or time.time() * 1000 - plan['createdAt'] > 3600000:
            raise ValueError('清理清单过期或已执行')
        reclaimed, skipped = 0, []
        for item in plan['files']:
            path = self.root / item['path']
            if not item['path'].startswith(('frontend/dist/', 'frontend/.vite/', 'backend/outputs/', 'backend/service-logs/')) or not path.resolve().is_relative_to(self.root) or path.is_symlink() or any(p.is_symlink() for p in path.parents if p.is_relative_to(self.root)):
                skipped.append(item['path'])
                continue
            try:
                if path.stat().st_size != item['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
                    raise ValueError('文件改变')
                path.unlink()
                reclaimed += item['bytes']
            except (OSError, ValueError):
                skipped.append(item['path'])
        self.state.put('cleanup', manifest, plan | dict(executed=True, reclaimedBytes=reclaimed, skipped=skipped))
        return dict(reclaimedBytes=reclaimed, skipped=skipped)


def create_maintenance_server(auth, service):
    tools = {
        'maintenance_context': ('maintenance:read', schema(), lambda a: service.context()),
        'source_read': ('maintenance:read', schema({'path': string(), 'start': {'type': 'integer', 'minimum': 1}, 'lines': {'type': 'integer', 'minimum': 1, 'maximum': 200}, 'change_id': string()}, ['path']), lambda a: service.read_source(a['path'], a.get('start', 1), a.get('lines', 100), a.get('change_id'))),
        'source_search': ('maintenance:read', schema({'query': string()}, ['query']), lambda a: service.search_source(a['query'])),
        'change_create': ('maintenance:write', schema({'base_commit': string()}, ['base_commit']), lambda a: service.create_change(a['base_commit'])),
        'source_hash': ('maintenance:read', schema({'change_id': string(), 'path': string()}, ['change_id', 'path']), lambda a: service.file_hash(a['change_id'], a['path'])),
        'change_apply': ('maintenance:write', schema({'change_id': string(), 'path': string(), 'content': {'type': 'string', 'maxLength': 256000}, 'expected_hash': {'type': ['string', 'null']}}, ['change_id', 'path', 'content', 'expected_hash']), lambda a: service.apply_patch(a['change_id'], a['path'], a['content'], a['expected_hash'])),
        'change_diff': ('maintenance:read', schema({'change_id': string(), 'offset': {'type': 'integer', 'minimum': 0}}, ['change_id']), lambda a: service.diff(a['change_id'], a.get('offset', 0))),
        'checks_run': ('maintenance:write', schema({'change_id': string()}, ['change_id']), lambda a: service.submit_job('checks', lambda: service.run_checks(a['change_id']))),
        'job_status': ('maintenance:read', schema({'job_id': string()}, ['job_id']), lambda a: service.job(a['job_id'])),
        'release_prepare': ('maintenance:release', schema({'change_id': string()}, ['change_id']), lambda a: service.submit_job('prepare', lambda: service.prepare_release(a['change_id']))),
        'release_deploy': ('maintenance:release', schema({'release_id': string()}, ['release_id']), lambda a: service.submit_job('deploy', lambda: service.deploy_release(a['release_id']))),
        'rollback_prepare': ('maintenance:release', schema({'release_id': string()}, ['release_id']), lambda a: service.prepare_rollback(a['release_id'])),
        'cleanup_preview': ('maintenance:cleanup', schema(), lambda a: service.cleanup_preview()),
        'cleanup_apply': ('maintenance:cleanup', schema({'manifest_id': string(), 'release_id': string()}, ['manifest_id', 'release_id']), lambda a: service.cleanup_apply(a['manifest_id'], a['release_id'])),
    }
    def permission(context):
        request = context.request
        if not request:
            return []
        return auth.verify(request.headers.get('authorization', '').removeprefix('Bearer '))['scopes']
    async def listing(context, params):
        scopes = permission(context)
        return ListToolsResult(tools=[Tool(name=name, description=name, inputSchema=values[1], annotations=ToolAnnotations(readOnlyHint=values[0] == 'maintenance:read' or name == 'cleanup_preview', openWorldHint=False)) for name, values in tools.items() if values[0] in scopes])
    async def calling(context, params):
        try:
            item = tools.get(params.name)
            if not item or item[0] not in permission(context):
                raise ConnectorError(403, '权限不足')
            value = item[2](params.arguments or {})
            if hasattr(value, '__await__'):
                value = await value
            service.state.audit('owner', 'mcp:' + params.name, '', 'ok')
            return text_result(value)
        except Exception as error:
            service.state.audit('owner', 'mcp:' + params.name, '', 'failed')
            return text_result({'message': str(error)}, True)
    return Server('matrix-cloud-maintenance', version='1.0.0', on_list_tools=listing, on_call_tool=calling, get_tool_input_schema=lambda name: tools.get(name, (None, None, None))[1])


def load_config(settings):
    if not settings.maintenance_config:
        return None
    file = Path(settings.maintenance_config)
    if os.name != 'nt' and file.stat().st_mode & 0o077:
        raise ValueError('维护配置文件必须仅管理员可读')
    config = json.loads(file.read_text(encoding='utf-8'))
    resource = urlsplit(config['resource'])
    if resource.scheme != 'https' or resource.path != '/maintenance/mcp' or resource.username or resource.password:
        raise ValueError('维护接口必须使用独立 HTTPS 地址下的 /maintenance/mcp')
    return config


def install_maintenance_routes(app, settings):
    config = load_config(settings)
    auth = MaintenanceAuth(config) if config else None
    service = MaintenanceService(config) if config else None
    app.state.maintenance_auth, app.state.maintenance_service = auth, service
    origin = urlsplit(config['resource']).scheme + '://' + urlsplit(config['resource']).netloc if config else None
    tries = {}
    def form(identifier, content):
        response = HTMLResponse('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>矩阵云维护授权</title><body>' + content + '</body></html>')
        response.set_cookie('matrix_maintenance_csrf', identifier, max_age=300, httponly=True, secure=True, samesite='lax', path='/maintenance')
        return response
    def verify_form(request, fields):
        if request.headers.get('origin') != origin or not fields.get('csrf') or not hmac.compare_digest(fields['csrf'], request.cookies.get('matrix_maintenance_csrf', '')):
            raise ConnectorError(403, '页面验证已失效，请重新打开')
        ip, now = request.client.host, time.time()
        bucket = tries.get(ip, dict(count=0, until=now + 60))
        if bucket['until'] <= now:
            bucket = dict(count=0, until=now + 60)
        if bucket['count'] >= 5:
            raise ConnectorError(403, '验证次数过多，请一分钟后重试')
        bucket['count'] += 1
        tries[ip] = bucket
    @app.middleware('http')
    async def maintenance_headers(request, call_next):
        if not request.url.path.startswith(('/maintenance', '/.well-known', '/authorize', '/token', '/revoke')):
            return await call_next(request)
        if origin and request.headers.get('origin') and request.headers['origin'] != origin:
            return JSONResponse({'message': '来源不允许'}, 403)
        if request.url.path == '/maintenance/mcp':
            if not auth:
                return JSONResponse({'message': '维护服务尚未配置'}, 503)
            if request.method != 'POST':
                return Response(status_code=405, headers={'Allow': 'POST'})
            try:
                auth.verify(request.headers.get('authorization', '').removeprefix('Bearer '))
            except ConnectorError as error:
                return JSONResponse({'message': str(error)}, 401, headers={'WWW-Authenticate': 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource/maintenance/mcp"'})
        response = await call_next(request)
        response.headers.update({'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff'})
        return response
    @app.get('/maintenance/health')
    async def health():
        return JSONResponse(dict(ok=True, service='matrix-maintenance')) if config else JSONResponse({'message': '维护服务尚未配置'}, 503)
    @app.get('/.well-known/oauth-authorization-server')
    async def metadata():
        if not config:
            return JSONResponse({'message': '维护服务尚未配置'}, 503)
        return JSONResponse(dict(issuer=origin, authorization_endpoint=origin + '/authorize', token_endpoint=origin + '/token', revocation_endpoint=origin + '/revoke', scopes_supported=SCOPES, response_types_supported=['code'], grant_types_supported=['authorization_code', 'refresh_token'], code_challenge_methods_supported=['S256'], token_endpoint_auth_methods_supported=['none'], authorization_response_iss_parameter_supported=True))
    @app.get('/.well-known/oauth-protected-resource/maintenance/mcp')
    async def resource_metadata():
        return JSONResponse(dict(resource=config['resource'], authorization_servers=[origin], scopes_supported=SCOPES)) if config else JSONResponse({'message': '维护服务尚未配置'}, 503)
    @app.get('/authorize')
    async def authorize(request: Request):
        if not auth:
            return JSONResponse({'message': '维护服务尚未配置'}, 503)
        try:
            pending = auth.begin(dict(request.query_params))
            return RedirectResponse('/maintenance/consent?id=' + pending['id'], 302)
        except ConnectorError as error:
            return JSONResponse({'error': 'invalid_request', 'error_description': str(error)}, error.status)
    @app.post('/token')
    async def token(request: Request):
        if not auth:
            return JSONResponse({'message': '维护服务尚未配置'}, 503)
        try:
            fields = {key: value[-1] for key, value in parse_qs((await request.body()).decode()).items()}
            return JSONResponse(auth.exchange(fields))
        except ConnectorError as error:
            return JSONResponse({'error': 'invalid_grant', 'error_description': str(error)}, 400)
    @app.post('/revoke')
    async def revoke(request: Request):
        if not auth:
            return JSONResponse({'message': '维护服务尚未配置'}, 503)
        fields = {key: value[-1] for key, value in parse_qs((await request.body()).decode()).items()}
        auth.revoke(fields.get('client_id'), fields.get('token', ''))
        return Response(status_code=200)
    @app.api_route('/maintenance/consent', methods=['GET', 'POST'])
    async def consent(request: Request):
        if not auth:
            return JSONResponse({'message': '维护服务尚未配置'}, 503)
        try:
            if request.method == 'GET':
                pending = auth.pending(request.query_params.get('id', ''))
                return form(pending['id'], '<h1>允许客户端维护矩阵云</h1><p>客户端：' + html.escape(pending['clientId']) + '</p><p>权限：' + html.escape('、'.join(pending['scopes'])) + '</p><form method="post"><input type="hidden" name="csrf" value="' + html.escape(pending['id']) + '"><label>维护管理员密码 <input name="password" type="password" required autocomplete="current-password"></label><button>授权</button></form>')
            fields = {key: value[-1] for key, value in parse_qs((await request.body()).decode()).items()}
            verify_form(request, fields)
            return RedirectResponse(auth.consent(fields['csrf'], fields.get('password', '')), 302)
        except (ConnectorError, ValueError) as error:
            return HTMLResponse(html.escape(str(error)), 403 if request.method == 'POST' else 400)
    @app.api_route('/maintenance/releases/{id}/approve', methods=['GET', 'POST'])
    async def approve(request: Request, id: str):
        if not service:
            return JSONResponse({'message': '维护服务尚未配置'}, 503)
        release = service.state.get('release', id)
        if not re.fullmatch(r'[a-f0-9-]{36}', id) or not release or release['status'] != 'prepared':
            return HTMLResponse('发布版本不存在或已执行', 404)
        try:
            if request.method == 'GET':
                nonce = secrets.token_hex(32)
                auth.state.put('approval-form', digest(nonce), dict(releaseId=id, expires=time.time() * 1000 + 300000, stage='login'))
                return form(nonce, '<h1>管理员审查发布版本</h1><form method="post"><input type="hidden" name="csrf" value="' + nonce + '"><label>维护管理员密码 <input name="password" type="password" required></label><button>验证并查看差异</button></form>')
            fields = {key: value[-1] for key, value in parse_qs((await request.body()).decode()).items()}
            verify_form(request, fields)
            pending = auth.state.get('approval-form', digest(fields['csrf']))
            if not pending or pending['releaseId'] != id or pending['expires'] < time.time() * 1000 or not password_matches(fields.get('password', ''), config['adminHash']):
                raise ValueError('发布确认验证失败')
            auth.state.remove('approval-form', digest(fields['csrf']))
            if pending['stage'] == 'login':
                nonce = secrets.token_hex(32)
                auth.state.put('approval-form', digest(nonce), dict(releaseId=id, commit=release['commit'], imageDigest=release['imageDigest'], expires=time.time() * 1000 + 300000, stage='review'))
                return form(nonce, '<h1>确认维护版本上线</h1><p>版本：' + html.escape(release['commit']) + '</p><p>镜像：' + html.escape(release['imageDigest']) + '</p><pre>' + html.escape(service.diff(release['changeId'])) + '</pre><form method="post"><input type="hidden" name="csrf" value="' + nonce + '"><label><input type="checkbox" name="compatible" value="yes" required>已审查完整差异、检查结果、备份及数据库回滚兼容性</label><label>维护管理员密码 <input name="password" type="password" required></label><button>确认此版本，15分钟内有效</button></form>')
            if pending['stage'] != 'review' or pending['commit'] != release['commit'] or pending['imageDigest'] != release['imageDigest'] or fields.get('compatible') != 'yes':
                raise ValueError('版本确认已失效')
            service.approve_release(id, 'owner')
            return HTMLResponse('已确认此版本，可返回维护客户端。分离版发布仍须使用经审查的双容器流程。')
        except ValueError as error:
            return HTMLResponse(html.escape(str(error)), 403)
    if auth:
        manager = StreamableHTTPSessionManager(create_maintenance_server(auth, service), stateless=True, json_response=True)
        app.state.mcp_managers = getattr(app.state, 'mcp_managers', []) + [manager]
        app.add_route('/maintenance/mcp', HttpTransport(manager), methods=['GET', 'POST', 'DELETE'])


def run_maintenance(settings=None, port=4176):
    from .settings import Settings
    import uvicorn
    settings = settings or Settings.from_env()
    if not load_config(settings):
        raise ValueError('请配置私有的 MAINTENANCE_CONFIG 文件')
    @asynccontextmanager
    async def lifespan(app):
        from contextlib import AsyncExitStack
        async with AsyncExitStack() as stack:
            for manager in getattr(app.state, 'mcp_managers', []):
                await stack.enter_async_context(manager.run())
            yield
    app = FastAPI(lifespan=lifespan)
    install_maintenance_routes(app, settings)
    uvicorn.run(app, host='127.0.0.1', port=port, proxy_headers=False)

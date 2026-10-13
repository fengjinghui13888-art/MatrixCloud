"""Device pairing, authenticated protocol-4 RPC, and narrowly scoped execution grants."""
from __future__ import annotations
import asyncio
import base64
import hashlib
import hmac
import inspect
import json
import re
import secrets
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

from .protocols import (OMITTED, valid_connector_command, valid_xhs_event,
                        valid_xhs_subscriptions, MAX_RPC_ACTIVE, MAX_RPC_BYTES)


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class ConnectorError(ValueError):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class Pairing:
    def __init__(self, file: Path, now=None):
        self.file = Path(file)
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.now = now or (lambda: int(time.time() * 1000))
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.file, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS connector_pairings(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,code_hash TEXT UNIQUE NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL,device_id TEXT,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS connector_devices(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,name TEXT NOT NULL,platform TEXT NOT NULL,version TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,last_seen_at INTEGER NOT NULL,revoked_at INTEGER);
        CREATE TABLE IF NOT EXISTS connector_limits(key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS connector_selections(workspace TEXT PRIMARY KEY,device_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS connector_bindings(workspace TEXT NOT NULL,profile TEXT NOT NULL,device_id TEXT NOT NULL,PRIMARY KEY(workspace,profile));
        CREATE TABLE IF NOT EXISTS connector_runs(workspace TEXT NOT NULL,id TEXT NOT NULL,device_id TEXT NOT NULL,profile TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(workspace,id));
        ''')
        self.db.commit()

    def _rate(self, key, maximum, period):
        window = self.now() // period
        row = self.db.execute('INSERT INTO connector_limits VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count', (key, window)).fetchone()
        self.db.commit()
        if row['count'] > maximum:
            raise ConnectorError(429, '操作过于频繁，请稍后再试')

    def _expire(self):
        self.db.execute("UPDATE connector_pairings SET status='expired' WHERE status='pending' AND expires_at<=?", (self.now(),))
        self.db.execute("DELETE FROM connector_pairings WHERE expires_at<? AND status!='pending'", (self.now() - 86400000,))
        self.db.execute("DELETE FROM connector_limits WHERE (key LIKE 'register:%' AND window<?) OR (key LIKE 'issue:%' AND window<?)", (self.now() // 60000 - 2, self.now() // 3600000 - 2))
        self.db.commit()

    def create(self, workspace):
        with self.lock:
            self._expire()
            self._rate('issue:' + workspace, 10, 3600000)
            identifier, code, expiry = str(uuid.uuid4()), f'{secrets.randbelow(100000000):08}', self.now() + 300000
            with self.db:
                self.db.execute("UPDATE connector_pairings SET status='cancelled' WHERE workspace=? AND status='pending'", (workspace,))
                self.db.execute('INSERT INTO connector_pairings(id,workspace,code_hash,expires_at,status,created_at) VALUES(?,?,?,?,?,?)', (identifier, workspace, digest(code), expiry, 'pending', stamp()))
            return {'id': identifier, 'code': code, 'status': 'pending', 'expiresAt': expiry, 'expiresInSeconds': 300}

    def device_by_id(self, identifier, workspace):
        with self.lock:
            row = self.db.execute('SELECT id,workspace,name,platform,version,created_at AS createdAt,last_seen_at AS lastSeenAt,revoked_at AS revokedAt FROM connector_devices WHERE id=? AND workspace=?', (identifier, workspace)).fetchone()
            return dict(row) if row else None

    def public_device(self, device):
        return {'id': device['id'], 'name': device['name'], 'platform': device['platform'], 'version': device['version'], 'createdAt': device['createdAt'], 'lastSeenAt': datetime.fromtimestamp(device['lastSeenAt'] / 1000, timezone.utc).isoformat().replace('+00:00', 'Z') if device['lastSeenAt'] else None, 'online': device['revokedAt'] is None and device['lastSeenAt'] > 0 and self.now() - device['lastSeenAt'] <= 90000, 'revoked': device['revokedAt'] is not None}

    def devices(self, workspace):
        with self.lock:
            ids = self.db.execute('SELECT id FROM connector_devices WHERE workspace=? ORDER BY created_at DESC', (workspace,)).fetchall()
            return [self.public_device(self.device_by_id(row['id'], workspace)) for row in ids]

    def pairing_status(self, identifier, workspace):
        with self.lock:
            self._expire()
            row = self.db.execute('SELECT id,status,expires_at AS expiresAt,device_id AS deviceId FROM connector_pairings WHERE id=? AND workspace=?', (identifier, workspace)).fetchone()
            if not row:
                raise ConnectorError(404, '配对任务不存在')
            result = {key: row[key] for key in ('id', 'status', 'expiresAt')}
            if row['deviceId']:
                result['device'] = self.public_device(self.device_by_id(row['deviceId'], workspace))
            return result

    def register(self, code, name, platform, version, source='local'):
        with self.lock:
            self._expire()
            self._rate('register:' + digest(source), 10, 60000)
            self._rate('register:global', 500, 60000)
            if not isinstance(code, str) or not re.fullmatch(r'\d{8}', code) or not isinstance(name, str) or not name.strip() or len(name) > 100 or re.search(r'[\x00-\x1f]', name) or platform not in ('darwin', 'win32', 'linux') or not isinstance(version, str) or len(version) > 40 or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?', version):
                raise ConnectorError(400, '连接器注册参数无效')
            identifier, token = str(uuid.uuid4()), secrets.token_hex(32)
            with self.db:
                row = self.db.execute("SELECT * FROM connector_pairings WHERE code_hash=? AND status='pending' AND expires_at>?", (digest(code), self.now())).fetchone()
                if not row:
                    raise ConnectorError(409, '配对码无效、已使用或已过期，请生成新码')
                self.db.execute('INSERT INTO connector_devices VALUES(?,?,?,?,?,?,?,?,NULL)', (identifier, row['workspace'], name.strip(), platform, version, digest(token), stamp(), 0))
                self.db.execute("UPDATE connector_pairings SET status='claimed',device_id=? WHERE id=?", (identifier, row['id']))
            return {'deviceId': identifier, 'deviceToken': token, 'workspace': row['workspace'], 'heartbeatIntervalSeconds': 30}

    def authenticate(self, token):
        if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{64}', token, re.I):
            raise ConnectorError(401, '连接器凭证无效或已撤销，请重新配对')
        with self.lock:
            row = self.db.execute('SELECT id,workspace FROM connector_devices WHERE token_hash=? AND revoked_at IS NULL', (digest(token),)).fetchone()
            if not row:
                raise ConnectorError(401, '连接器凭证无效或已撤销，请重新配对')
            return self.device_by_id(row['id'], row['workspace'])

    def heartbeat(self, token):
        with self.lock:
            device = self.authenticate(token)
            with self.db:
                self.db.execute('UPDATE connector_devices SET last_seen_at=? WHERE id=? AND revoked_at IS NULL', (self.now(), device['id']))
            return {'ok': True, 'device': self.public_device(self.device_by_id(device['id'], device['workspace']))}

    def revoke(self, identifier, workspace):
        with self.lock:
            if not self.device_by_id(identifier, workspace):
                raise ConnectorError(404, '连接器不存在')
            with self.db:
                self.db.execute('UPDATE connector_devices SET revoked_at=coalesce(revoked_at,?) WHERE id=? AND workspace=?', (self.now(), identifier, workspace))
            return {'ok': True, 'id': identifier}

    def cancel(self, identifier, workspace):
        with self.lock:
            self.pairing_status(identifier, workspace)
            with self.db:
                self.db.execute("UPDATE connector_pairings SET status='cancelled' WHERE id=? AND workspace=? AND status='pending'", (identifier, workspace))
            return self.pairing_status(identifier, workspace)

    def storage_binding(self, workspace, profile):
        with self.lock:
            row = self.db.execute('SELECT device_id FROM connector_bindings WHERE workspace=? AND profile=?', (workspace, profile)).fetchone()
            return row['device_id'] if row else None

    def storage_selected(self, workspace):
        with self.lock:
            row = self.db.execute('SELECT device_id FROM connector_selections WHERE workspace=?', (workspace,)).fetchone()
            return row['device_id'] if row else None

    def storage_select(self, workspace, identifier):
        with self.lock, self.db:
            self.db.execute('INSERT INTO connector_selections VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET device_id=excluded.device_id', (workspace, identifier))

    def storage_bind(self, workspace, profile, identifier):
        with self.lock, self.db:
            self.db.execute('INSERT OR IGNORE INTO connector_bindings VALUES(?,?,?)', (workspace, profile, identifier))

    def storage_run(self, workspace, run, identifier=None, profile=None, kind=None):
        with self.lock, self.db:
            if identifier:
                self.db.execute('INSERT OR IGNORE INTO connector_runs VALUES(?,?,?,?,?)', (workspace, run, identifier, profile, kind))
            row = self.db.execute('SELECT * FROM connector_runs WHERE workspace=? AND id=?', (workspace, run)).fetchone()
            return dict(row) if row else None

    def close(self):
        with self.lock:
            self.db.close()


class PostgresPairing(Pairing):
    """Original normalized device tables; never creates a parallel SQLite registry."""
    columns = 'id,tenant_id AS workspace,name,platform,version,created_at AS "createdAt",last_seen_at::float8 AS "lastSeenAt",revoked_at::float8 AS "revokedAt"'
    def __init__(self, database):
        self.database = database
        self.now = lambda: int(time.time() * 1000)
        self.lock = threading.RLock()

    def close(self):
        pass  # PostgreSQL connections are owned by individual transactions.

    def _global(self, statement, params=()):
        with self.database._connection() as connection:
            result = connection.execute(statement, params)
            return result.fetchall() if result.description else []

    def _rate(self, key, maximum, period):
        row = self._global('INSERT INTO connector_limit VALUES(%s,%s,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN connector_limit.bucket=excluded.bucket THEN connector_limit.count+1 ELSE 1 END,bucket=excluded.bucket RETURNING count', (key, self.now() // period))[0]
        if row['count'] > maximum:
            raise ConnectorError(429, '操作过于频繁，请稍后再试')

    def device_by_id(self, identifier, workspace):
        rows = self.database.rows(workspace, 'SELECT ' + self.columns + ' FROM device WHERE tenant_id=%s AND id=%s', (workspace, identifier))
        return dict(rows[0]) if rows else None

    def devices(self, workspace):
        return [self.public_device(row) for row in self.database.rows(workspace, 'SELECT ' + self.columns + ' FROM device WHERE tenant_id=%s ORDER BY created_at DESC', (workspace,))]

    def create(self, workspace):
        if not self.database.active(workspace):
            raise ConnectorError(403, '客户已停用')
        self._rate('issue:' + workspace, 10, 3600000)
        identifier, code, expiry = str(uuid.uuid4()), f'{secrets.randbelow(100000000):08}', self.now() + 300000
        with self.database.transaction(workspace) as connection:
            connection.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (workspace + ':pairing',))
            connection.execute("UPDATE device_pairing SET status='cancelled' WHERE tenant_id=%s AND status='pending'", (workspace,))
            connection.execute("INSERT INTO device_pairing(tenant_id,id,code_hash,expires_at,status,created_at) VALUES(%s,%s,%s,%s,'pending',%s)", (workspace, identifier, digest(code), expiry, stamp()))
        return dict(id=identifier, code=code, status='pending', expiresAt=expiry, expiresInSeconds=300)

    def pairing_status(self, identifier, workspace):
        with self.database.transaction(workspace) as connection:
            connection.execute("UPDATE device_pairing SET status='expired' WHERE tenant_id=%s AND id=%s AND status='pending' AND expires_at<=%s", (workspace, identifier, self.now()))
            row = connection.execute('SELECT id,status,expires_at::float8 AS "expiresAt",device_id AS "deviceId" FROM device_pairing WHERE tenant_id=%s AND id=%s', (workspace, identifier)).fetchone()
            if not row:
                raise ConnectorError(404, '配对任务不存在')
        result = {key: row[key] for key in ('id', 'status', 'expiresAt')}
        if row['deviceId']:
            result['device'] = self.public_device(self.device_by_id(row['deviceId'], workspace))
        return result

    def register(self, code, name, platform, version, source='local'):
        self._rate('register:' + digest(source), 10, 60000)
        self._rate('register:global', 500, 60000)
        if not isinstance(code, str) or not re.fullmatch(r'\d{8}', code) or not isinstance(name, str) or not name.strip() or len(name) > 100 or re.search(r'[\x00-\x1f]', name) or platform not in ('darwin', 'win32', 'linux') or not isinstance(version, str) or len(version) > 40 or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?', version):
            raise ConnectorError(400, '连接器注册参数无效')
        identifier, token = str(uuid.uuid4()), secrets.token_hex(32)
        with self.database._connection() as connection, connection.transaction():
            row = connection.execute("SELECT p.tenant_id FROM device_pairing p JOIN tenant t ON t.tenant_id=p.tenant_id WHERE code_hash=%s AND status='pending' AND expires_at>%s AND t.enabled FOR UPDATE OF p", (digest(code), self.now())).fetchone()
            if not row:
                raise ConnectorError(409, '配对码无效、已使用或已过期，请生成新码')
            connection.execute('INSERT INTO device VALUES(%s,%s,%s,%s,%s,%s,%s,0,NULL)', (row['tenant_id'], identifier, name.strip(), platform, version, digest(token), stamp()))
            connection.execute("UPDATE device_pairing SET status='claimed',device_id=%s WHERE code_hash=%s", (identifier, digest(code)))
        return dict(deviceId=identifier, deviceToken=token, workspace=row['tenant_id'], heartbeatIntervalSeconds=30)

    def authenticate(self, token):
        if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{64}', token, re.I):
            raise ConnectorError(401, '连接器凭证无效或已撤销，请重新配对')
        rows = self._global('SELECT ' + self.columns + ' FROM device WHERE token_hash=%s AND revoked_at IS NULL', (digest(token),))
        if not rows:
            raise ConnectorError(401, '连接器凭证无效或已撤销，请重新配对')
        if not self.database.active(rows[0]['workspace']):
            raise ConnectorError(403, '客户已停用')
        return dict(rows[0])

    def heartbeat(self, token):
        device = self.authenticate(token)
        rows = self.database.rows(device['workspace'], 'UPDATE device SET last_seen_at=%s WHERE tenant_id=%s AND id=%s AND revoked_at IS NULL RETURNING ' + self.columns, (self.now(), device['workspace'], device['id']))
        if not rows:
            raise ConnectorError(401, '连接器已撤销')
        return dict(ok=True, device=self.public_device(rows[0]))

    def revoke(self, identifier, workspace):
        rows = self.database.rows(workspace, 'UPDATE device SET revoked_at=coalesce(revoked_at,%s) WHERE tenant_id=%s AND id=%s RETURNING id', (self.now(), workspace, identifier))
        if not rows:
            raise ConnectorError(404, '连接器不存在')
        return dict(ok=True, id=identifier)

    def cancel(self, identifier, workspace):
        self.pairing_status(identifier, workspace)
        self.database.rows(workspace, "UPDATE device_pairing SET status='cancelled' WHERE tenant_id=%s AND id=%s AND status='pending'", (workspace, identifier))
        return self.pairing_status(identifier, workspace)

    def storage_binding(self, workspace, profile):
        rows = self.database.rows(workspace, 'SELECT device_id FROM device_binding WHERE tenant_id=%s AND profile=%s', (workspace, profile))
        return rows[0]['device_id'] if rows else None

    def storage_selected(self, workspace):
        rows = self.database.rows(workspace, 'SELECT device_id FROM device_selection WHERE tenant_id=%s', (workspace,))
        return rows[0]['device_id'] if rows else None

    def storage_select(self, workspace, identifier):
        self.database.rows(workspace, 'INSERT INTO device_selection VALUES(%s,%s) ON CONFLICT(tenant_id) DO UPDATE SET device_id=excluded.device_id', (workspace, identifier))

    def storage_bind(self, workspace, profile, identifier):
        self.database.rows(workspace, 'INSERT INTO device_binding VALUES(%s,%s,%s) ON CONFLICT DO NOTHING', (workspace, profile, identifier))

    def storage_run(self, workspace, run, identifier=None, profile=None, kind=None):
        with self.database.transaction(workspace) as connection:
            if identifier:
                connection.execute('INSERT INTO device_run VALUES(%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING', (workspace, run, identifier, profile, kind))
            row = connection.execute('SELECT device_id,profile,kind FROM device_run WHERE tenant_id=%s AND id=%s', (workspace, run)).fetchone()
            return dict(row) if row else None


class ExecutionGrants:
    def __init__(self):
        self.grants = {}

    def issue(self, workspace, task_id=None, account_id=None, profile=None, device_id=None, run_id=None, validate=None):
        token = secrets.token_hex(32)
        self.grants[token] = dict(workspace=workspace, taskId=task_id, accountId=account_id, profile=profile, deviceId=device_id, runId=run_id, validate=validate, expires=time.time() + 900)
        return token

    async def validate(self, token):
        grant = self.get(token)
        if grant and grant['validate']:
            try:
                okay = grant['validate']()
                if inspect.isawaitable(okay):
                    okay = await okay
            except Exception:
                okay = False
            if not okay:
                self.grants.pop(token, None)
                return None
        return grant

    def get(self, token):
        grant = self.grants.get(token)
        if grant and grant['expires'] < time.time():
            self.grants.pop(token, None)
            return None
        return grant

    def allowed(self, token, method, path):
        grant = self.get(token)
        if not grant:
            return False
        if not grant['taskId']:
            return path.startswith('/api/connector/relay/sync/' + grant['runId']) or path == '/api/sync-jobs/' + grant['runId'] + '/progress' or method == 'POST' and path == '/api/import'
        task = re.escape(grant['taskId'])
        return (method == 'GET' and (path in ('/api/operations', '/api/studio/' + grant['taskId']) or re.fullmatch(r'/api/studio/' + task + r'/media/[a-f0-9]{64}\.(png|jpg|webp)', path))) or (method == 'POST' and path in ['/api/studio/' + grant['taskId'] + '/' + action for action in ('claim', 'progress', 'receipt')])


class ConnectorChannel:
    def __init__(self, pairing, active_workspace=None):
        self.pairing, self.peers, self.pending = pairing, {}, {}
        self.event_handlers, self.connected_handlers = [], []
        self.active_workspace = active_workspace or (lambda workspace: True)

    async def online(self, identifier):
        peer = self.peers.get(identifier)
        if not peer:
            return False
        try:
            device = self.pairing.authenticate(peer['token'])
            if not self.active_workspace(device['workspace']):
                raise ConnectorError(401, '客户已停用')
            return True
        except ConnectorError:
            await self.close(identifier)
            return False

    def binding(self, workspace, profile):
        return self.pairing.storage_binding(workspace, profile)

    def selected(self, workspace):
        return self.pairing.storage_selected(workspace)

    def select(self, workspace, identifier):
        device = self.pairing.device_by_id(identifier, workspace)
        if not device or device['revokedAt'] is not None:
            raise ConnectorError(404, '连接器不存在或已撤销')
        self.pairing.storage_select(workspace, identifier)

    async def browser_device(self, workspace, choice=None):
        if not choice:
            devices = [d for d in self.pairing.devices(workspace) if not d['revoked']]
            if len(devices) != 1:
                raise ConnectorError(409, '请在账号矩阵选择当前要执行的电脑' if devices else '请先配对并启动客户电脑上的连接器')
            choice = devices[0]['id']
        device = self.pairing.device_by_id(choice, workspace)
        if not device or device['revokedAt'] is not None:
            raise ConnectorError(403, '所选电脑不属于当前客户或已撤销，请重新选择')
        if not await self.online(choice):
            raise ConnectorError(409, f'所选电脑“{device["name"]}”离线，请在该电脑启动连接器')
        return choice

    async def bind(self, workspace, profile, identifier):
        if not re.fullmatch(r'local:[\w-]{1,100}', profile):
            raise ConnectorError(400, '账号会话无效')
        device = self.pairing.device_by_id(identifier, workspace)
        if not device or device['revokedAt'] is not None:
            raise ConnectorError(403, '设备不属于当前客户')
        self.pairing.storage_bind(workspace, profile, identifier)
        if self.binding(workspace, profile) != identifier:
            raise ConnectorError(409, '此账号已绑定其他设备，请先在原设备处理')

    def authorize(self, workspace, identifier, method, path, body=OMITTED):
        device = self.pairing.device_by_id(identifier, workspace)
        if not device or device['revokedAt'] is not None or not self.active_workspace(workspace):
            raise ConnectorError(403, '连接器不属于当前客户或已撤销')
        if not valid_connector_command(method, path, body):
            raise ConnectorError(400, '不支持的连接器操作')
        if path == '/verify' or path == '/cleanup':
            return
        account = re.match(r'/accounts/([^/]+)', path)
        profile = 'local:' + account[1] if account else body['profile'] if path == '/studio' else body['target']['profile'] if method == 'POST' and re.fullmatch('/sync/[^/]+', path) else None
        if profile:
            if self.binding(workspace, profile) != identifier:
                raise ConnectorError(403, '账号未绑定此连接器')
            if not account:
                run = body['runId'] if path == '/studio' else path.split('/')[2]
                kind = 'studio' if path == '/studio' else 'sync'
                row = self.pairing.storage_run(workspace, run, identifier, profile, kind)
                if row['device_id'] != identifier or row['profile'] != profile or row['kind'] != kind:
                    raise ConnectorError(409, '任务绑定不一致')
            return
        _, kind, run, *_ = path.split('/')
        row = self.pairing.storage_run(workspace, run)
        if not row or row['device_id'] != identifier or row['kind'] != kind:
            raise ConnectorError(403, '任务不属于此客户和设备')

    async def request(self, workspace, identifier, method, path, body=OMITTED):
        self.authorize(workspace, identifier, method, path, body)
        if not await self.online(identifier):
            raise ConnectorError(409, '连接器离线，请保持客户电脑在线')
        if method == 'POST' and (path == '/studio' or re.fullmatch('/sync/[^/]+', path) or re.fullmatch('/accounts/[^/]+/login', path)):
            health = await self.json(workspace, identifier, 'GET', '/verify')
            if health.get('version') != 4 or not all(c in health.get('capabilities', []) for c in ('device-queue', 'stop-ack', 'passive-state', 'paced-actions')):
                raise ConnectorError(426, '请先升级此电脑的连接器，再开始新的自动化任务')
        if sum(p['deviceId'] == identifier for p in self.pending.values()) >= MAX_RPC_ACTIVE:
            raise ConnectorError(429, '此设备任务过多，请稍后重试')
        request_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = dict(deviceId=identifier, future=future, chunks=[], bytes=0, status=200, contentType='application/json')
        frame = dict(type='request', id=request_id, method=method, path=path)
        if body is not OMITTED:
            frame['body'] = body
        try:
            await self.peers[identifier]['socket'].send_json(frame)
            return await asyncio.wait_for(future, 120 if '/media/' in path else 60)
        except asyncio.TimeoutError:
            await self.peers[identifier]['socket'].send_json({'type': 'cancel', 'id': request_id})
            raise ConnectorError(504, '连接器响应超时，请核对任务状态后重试')
        finally:
            self.pending.pop(request_id, None)

    async def json(self, workspace, identifier, method, path, body=OMITTED):
        result = await self.request(workspace, identifier, method, path, body)
        try:
            value = json.loads(result['data'])
        except (ValueError, UnicodeError):
            raise ConnectorError(502, '连接器返回无效数据')
        if result['status'] >= 400:
            raise ConnectorError(result['status'], value.get('message', '连接器操作失败'))
        return value

    async def close(self, identifier):
        peer = self.peers.get(identifier)
        if peer:
            await peer['socket'].close(4001, 'revoked')

    async def watch(self, identifier, subscriptions):
        if not valid_xhs_subscriptions(subscriptions):
            raise ConnectorError(400, '事件订阅无效')
        if not await self.online(identifier):
            raise ConnectorError(409, '连接器离线')
        await self.peers[identifier]['socket'].send_json({'type': 'watch', 'subscriptions': subscriptions})

    async def frame(self, device, socket, frame):
        identifier = device['id']
        if not isinstance(frame, dict):
            raise ValueError('invalid frame')
        if self.peers.get(identifier, {}).get('socket') is not socket:
            return
        self.pairing.authenticate(self.peers[identifier]['token'])
        if frame.get('type') == 'event':
            event = frame.get('event')
            if not valid_xhs_event(event) or self.binding(device['workspace'], event['profile']) != identifier:
                raise ValueError('invalid event binding')
            accepted = [await handler(dict(workspace=device['workspace'], deviceId=identifier, event=event)) for handler in self.event_handlers]
            if accepted and all(accepted):
                await socket.send_json({'type': 'event-ack', 'eventId': event['eventId']})
            return
        pending = self.pending.get(frame.get('id'))
        if not pending or pending['deviceId'] != identifier:
            return
        kind = frame.get('type')
        if kind == 'head':
            status = frame.get('status')
            if type(status) is not int or not 200 <= status <= 599:
                raise ValueError('invalid status')
            pending['status'] = status
            pending['contentType'] = 'application/octet-stream' if frame.get('contentType') == 'application/octet-stream' else 'application/json'
        elif kind == 'chunk':
            data = frame.get('data')
            if not isinstance(data, str) or len(data) > 100000:
                raise ValueError('invalid chunk')
            chunk = base64.b64decode(data, validate=True)
            pending['bytes'] += len(chunk)
            if pending['bytes'] > MAX_RPC_BYTES:
                raise ValueError('response too large')
            pending['chunks'].append(chunk)
        elif kind in ('end', 'error'):
            if not pending['future'].done():
                if kind == 'error':
                    pending['future'].set_exception(ConnectorError(502, '本机执行失败，请检查连接器日志'))
                else:
                    pending['future'].set_result({k: pending[k] for k in ('status', 'contentType')} | {'data': b''.join(pending['chunks'])})

    async def websocket(self, socket):
        from starlette.websockets import WebSocketDisconnect
        token = socket.headers.get('authorization', '').removeprefix('Bearer ')
        try:
            device = self.pairing.authenticate(token)
            if not self.active_workspace(device['workspace']):
                raise ConnectorError(401, '客户已停用')
        except ConnectorError:
            await socket.close(4001)
            return
        await socket.accept()
        old = self.peers.get(device['id'])
        if old:
            await old['socket'].close(4000, 'replaced')
        self.peers[device['id']] = {'socket': socket, 'token': token}
        self.pairing.heartbeat(token)
        tasks = set()
        event_queue = asyncio.Queue()
        async def ordered_events():
            while True:
                frame = await event_queue.get()
                try:
                    await self.frame(device, socket, frame)
                except (ValueError, ConnectorError):
                    await socket.close(4002, 'invalid response')
                    return
                finally:
                    event_queue.task_done()
        event_worker = asyncio.create_task(ordered_events())
        for handler in self.connected_handlers:
            task = asyncio.create_task(handler(device['id'], device['workspace']))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
        async def audit_token():
            while True:
                await asyncio.sleep(30)
                if not await self.online(device['id']):
                    return
        audit = asyncio.create_task(audit_token())
        try:
            while True:
                raw = await socket.receive_text()
                if len(raw.encode()) > 512 * 1024:
                    raise ValueError('frame too large')
                frame = json.loads(raw)
                if not isinstance(frame, dict):
                    raise ValueError('invalid frame')
                if frame.get('type') == 'event':
                    # ACK follows persistence; independent responses can complete while event drain waits.
                    await event_queue.put(frame)
                else:
                    await self.frame(device, socket, frame)
        except WebSocketDisconnect:
            pass
        except (ValueError, ConnectorError):
            await socket.close(4002, 'invalid response')
        finally:
            audit.cancel()
            event_worker.cancel()
            if self.peers.get(device['id'], {}).get('socket') is socket:
                self.peers.pop(device['id'], None)
                for pending in self.pending.values():
                    if pending['deviceId'] == device['id'] and not pending['future'].done():
                        pending['future'].set_exception(ConnectorError(503, '连接器已断开，任务结果尚未确认'))


def browser_cookie(request, workspace):
    value = unquote(request.cookies.get('matrix_execution_device', ''))
    return value[len(workspace) + 1:] or None if value.startswith(workspace + ':') else None

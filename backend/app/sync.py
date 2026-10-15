"""Durable customer-device login and sync orchestration; no local browser fallback."""
from __future__ import annotations
import asyncio
import base64
import hashlib
import json
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from .gateway import ConnectorError, stamp


def atomic_json(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + '.' + str(uuid.uuid4()) + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temporary.replace(file)


def recent_ids(items, field='createdAt'):
    return [item['id'] for item in sorted(items, key=lambda item: (str(item.get(field, '')), item['id']), reverse=True)[:10000]]


class SyncJobs:
    def __init__(self, database, workspace):
        self.database, self.workspace = database, workspace

    def recover(self):
        self.database.rows(self.workspace, "WITH expired AS (UPDATE job SET status='blocked',lease_until=NULL,payload=payload||jsonb_build_object('status','blocked','stage','blocked','message','同步执行超时或中断，已保存内容保留，请重新同步','finishedAt',now()) WHERE tenant_id=%s AND kind='sync' AND status='running' AND lease_until<now() RETURNING id,attempt) UPDATE job_attempt a SET finished_at=now(),result='blocked' FROM expired e WHERE a.tenant_id=%s AND a.job_id=e.id AND a.attempt=e.attempt", (self.workspace, self.workspace))

    def read(self, identifier):
        self.recover()
        rows = self.database.rows(self.workspace, "SELECT payload FROM job WHERE tenant_id=%s AND id=%s AND kind='sync'", (self.workspace, identifier))
        return rows[0]['payload'] if rows else None

    def latest(self, account):
        self.recover()
        rows = self.database.rows(self.workspace, "SELECT payload FROM job WHERE tenant_id=%s AND account_id=%s AND kind='sync' ORDER BY created_at DESC LIMIT 1", (self.workspace, account))
        return rows[0]['payload'] if rows else None

    def running(self, account):
        self.recover()
        return bool(self.database.rows(self.workspace, "SELECT 1 FROM job WHERE tenant_id=%s AND account_id=%s AND kind='sync' AND status='running'", (self.workspace, account)))

    def create(self, state):
        with self.database.transaction(self.workspace) as connection:
            connection.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (self.workspace + ':sync:' + state['accountId'],))
            current = connection.execute("SELECT payload FROM job WHERE tenant_id=%s AND account_id=%s AND kind='sync' AND status='running'", (self.workspace, state['accountId'])).fetchone()
            if current:
                return dict(state=current['payload'], fresh=False)
            connection.execute("INSERT INTO job(tenant_id,id,account_id,kind,status,lease_until,payload,created_at) VALUES(%s,%s,%s,'sync','running',now()+interval '19 minutes',%s,%s)", (self.workspace, state['id'], state['accountId'], json.dumps(state), state['startedAt']))
            connection.execute('INSERT INTO job_attempt(tenant_id,job_id,attempt) VALUES(%s,%s,1)', (self.workspace, state['id']))
            return dict(state=state, fresh=True)

    def update(self, identifier, patch):
        with self.database.transaction(self.workspace) as connection:
            row = connection.execute("SELECT payload FROM job WHERE tenant_id=%s AND id=%s AND kind='sync' FOR UPDATE", (self.workspace, identifier)).fetchone()
            if not row:
                raise ConnectorError(404, '同步任务不存在')
            old = row['payload']
            stop = old['status'] == 'blocked' and patch.get('stopConfirmed') is True and old.get('stopConfirmed') is not True
            if old['status'] != 'running' and not stop:
                return old
            next_job = old | {'stopConfirmed': True} | ({'message': patch['message']} if isinstance(patch.get('message'), str) else {}) if stop else old | patch | {k: old[k] for k in ('id', 'accountId', 'profile', 'startedAt')}
            connection.execute("UPDATE job SET status=%s,payload=%s,lease_until=CASE WHEN %s='running' THEN lease_until ELSE NULL END WHERE tenant_id=%s AND id=%s", (next_job['status'], json.dumps(next_job), next_job['status'], self.workspace, identifier))
            if old['status'] == 'running' and next_job['status'] != 'running':
                connection.execute('UPDATE job_attempt SET finished_at=now(),result=%s WHERE tenant_id=%s AND job_id=%s AND attempt=1', (next_job['status'], self.workspace, identifier))
            return next_job


class WorkspaceExecution:
    def __init__(self, scope, channel, grants, callback, browser_file=None):
        self.scope, self.channel, self.grants, self.callback = scope, channel, grants, callback
        self.workspace = scope.workspace
        self.jobs, self.workers, self.locks = {}, {}, {}
        browser_file = browser_file or scope.root / 'browser-runs.sqlite'
        self.browser_db = sqlite3.connect(browser_file, check_same_thread=False)
        self.browser_db.row_factory = sqlite3.Row
        self.browser_db.execute('CREATE TABLE IF NOT EXISTS browser_run(account_hash TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,profile TEXT NOT NULL,created_at TEXT NOT NULL)')
        self.browser_db.commit()
        self.browser_lock = threading.RLock()
        database = getattr(scope.store, 'db', None)
        self.durable = SyncJobs(database, scope.workspace) if database else None
        for file in (scope.root / 'xhs-sync').glob('*.json'):
            if re.fullmatch(r'[a-f0-9-]{36}\.json', file.name):
                job = json.loads(file.read_text(encoding='utf-8'))
                if job.get('status') == 'running':
                    job.update(status='blocked', stage='blocked', message='服务重启中断了同步，已保存内容保留，请重新同步', finishedAt=stamp())
                    atomic_json(file, job)
                self.jobs[job['id']] = job
        self.on_terminal = None
        self.on_release = None

    def _account_key(self, handle):
        return hashlib.sha256(('xiaohongshu:' + handle.strip().lower()).encode()).hexdigest()

    @property
    def leases(self):
        result = {}
        for account in self.scope.store.list_accounts():
            row = self.browser_db.execute('SELECT run_id,profile FROM browser_run WHERE account_hash=?', (self._account_key(account['handle']),)).fetchone()
            if row:
                result[account['handle'].lower()] = dict(id=row['run_id'], profile=row['profile'])
        return result

    def account(self, identifier):
        return next((a for a in self.scope.store.list_accounts() if a['id'] == identifier), None)

    def lease(self, handle, identifier, profile):
        with self.browser_lock, self.browser_db:
            self.browser_db.execute('INSERT OR IGNORE INTO browser_run VALUES(?,?,?,?)', (self._account_key(handle), identifier, profile, stamp()))
            row = self.browser_db.execute('SELECT run_id FROM browser_run WHERE account_hash=?', (self._account_key(handle),)).fetchone()
            if row['run_id'] != identifier:
                raise ConnectorError(409, '此账号正在另一台电脑执行任务，或上次停止尚未确认')

    def release(self, identifier):
        with self.browser_lock, self.browser_db:
            removed = self.browser_db.execute('DELETE FROM browser_run WHERE run_id=?', (identifier,)).rowcount
        if removed and self.on_release:
            try:
                asyncio.get_running_loop().create_task(self.on_release())
            except RuntimeError:
                pass

    def busy(self, account):
        return account['handle'].lower() in self.leases

    def running(self, account_id):
        if self.durable:
            return self.durable.running(account_id)
        return any(j['accountId'] == account_id and j['status'] == 'running' for j in self.jobs.values())

    async def reconcile_stopped_sync(self, account):
        lease = self.leases.get(account['handle'].lower())
        if not lease or lease['id'] in self.workers:
            return False
        job = self.status(lease['id'])
        # Studio/unknown leases can contain an unconfirmed upload. Never
        # release those through read-only synchronization recovery.
        if not job or job['accountId'] != account['id'] or job['profile'] != account['profile']:
            return False
        device = self.channel.binding(self.workspace, account['profile'])
        state = await self.channel.json(self.workspace, device, 'GET', '/sync/' + job['id'])
        if state.get('status') not in ('complete','blocked','cancelled') or state.get('stopConfirmed') is not True:
            return False
        try:
            result = await self.channel.json(self.workspace, device, 'GET', '/sync/' + job['id'] + '/result')
            self.save_snapshot(result.get('snapshot',result),account,device,strip_media=True)
        except ConnectorError as error:
            if error.status != 404:
                raise
        await self.update(job['id'],dict(status='blocked',stopConfirmed=True,stage='blocked',message='上次同步已停止，已读取记录已保留，可以重新同步。',finishedAt=stamp()))
        self.release(job['id'])
        return True

    def status(self, identifier):
        if self.durable:
            return self.durable.read(identifier)
        return self.jobs.get(identifier)

    def latest(self, account_id):
        if self.durable:
            return self.durable.latest(account_id)
        return max((j for j in self.jobs.values() if j['accountId'] == account_id), key=lambda j: j['startedAt'], default=None)

    async def update(self, identifier, patch):
        job = self.status(identifier)
        if not job:
            raise ConnectorError(404, '同步任务不存在')
        if self.durable:
            job = self.durable.update(identifier, patch)
            self.jobs[identifier] = job
        elif job['status'] == 'blocked':
            if patch.get('stopConfirmed') is True and not job.get('stopConfirmed'):
                job.update(stopConfirmed=True)
                if isinstance(patch.get('message'), str):
                    job['message'] = patch['message']
            else:
                return job
        elif job['status'] != 'running':
            return job
        else:
            job.update({key: value for key, value in patch.items() if key not in ('id', 'accountId', 'profile', 'startedAt')})
        atomic_json(self.scope.root / 'xhs-sync' / (identifier + '.json'), job)
        if job['status'] in ('complete', 'partial') or job['status'] == 'blocked' and job.get('stopConfirmed'):
            self.release(identifier)
        if self.on_terminal and job['status'] in ('complete', 'partial', 'blocked'):
            asyncio.create_task(self.on_terminal(job))
        return job

    async def start(self, account_id, profile, options=None):
        options = options or {}
        async with self.locks.setdefault(account_id, asyncio.Lock()):
            account = self.account(account_id)
            if not account:
                raise ConnectorError(404, '账号不存在')
            if account['profile'] != profile or not profile.startswith('local:'):
                raise ConnectorError(409, '该账号尚未完成连接，请先扫码登录')
            if options.get('source') == 'event' and account['handle'] != options.get('expectedHandle'):
                raise ConnectorError(409, '事件的原账号绑定已改变')
            if self.busy(account):
                await self.reconcile_stopped_sync(account)
            active = next((j for j in self.jobs.values() if j['accountId'] == account_id and j['status'] == 'running'), None)
            if active:
                return active
            device = self.channel.binding(self.workspace, profile)
            if not device or options.get('source') == 'event' and device != options.get('eventDeviceId'):
                raise ConnectorError(409, '事件的原执行电脑绑定已改变' if options.get('source') == 'event' else '此账号尚未在客户电脑上登录，请重新扫码')
            identifier = str(uuid.uuid4())
            self.lease(account['handle'], identifier, profile)
            job = dict(id=identifier, accountId=account_id, profile=profile, status='running', stage='starting', message='正在连接客户执行电脑上的 Chrome…', counts=dict(notes=0, comments=0, messages=0), startedAt=stamp())
            if options.get('source'):
                job.update(source=options['source'], eventDeviceId=device)
            if self.durable:
                result = self.durable.create(job)
                if not result['fresh']:
                    self.release(identifier)
                    return result['state']
            self.jobs[identifier] = job
            atomic_json(self.scope.root / 'xhs-sync' / (identifier + '.json'), job)
            task = asyncio.create_task(self._collect(job, account, device, options))
            self.workers[identifier] = task
            task.add_done_callback(lambda _: self.workers.pop(identifier, None))
            return job

    async def _collect(self, job, account, device, options):
        identifier = job['id']
        try:
            known_notes = self.scope.store.list_notes({'accountId': account['id']})
            available = []
            for note in known_notes:
                for asset in note.get('mediaAssets', []):
                    file = self.scope.assets.file(asset['path'], account['id'], note['id'])
                    if file and file.stat().st_size == asset['bytes'] and hashlib.sha256(file.read_bytes()).hexdigest() == asset['sha256']:
                        available.append(note['id'] + ':' + asset['id'])
            body = dict(target=account, knownNotes=known_notes, knownComments=recent_ids(self.scope.store.list_comments({'accountId': account['id']})) if options.get('mode') else [], knownMessages=recent_ids(self.scope.store.list_messages({'accountId': account['id']})) if options.get('mode') else [], availableAssets=available)
            body.update({key: value for key, value in options.items() if key in ('mode', 'source', 'eventKinds')})
            await self.channel.json(self.workspace, device, 'POST', '/sync/' + identifier, body)
            deadline = time.monotonic() + 18 * 60
            checkpoint_at = 0
            while time.monotonic() < deadline:
                if job['status'] == 'blocked':
                    return
                state = await self.channel.json(self.workspace, device, 'GET', '/sync/' + identifier)
                if state.get('status') in ('complete', 'partial'):
                    break
                if state.get('status') in ('blocked', 'cancelled', 'stopping'):
                    raise ConnectorError(409, state.get('message', '同步执行未完成'))
                await self.update(identifier, {key: value for key, value in state.items() if key in ('stage', 'message', 'queuePosition', 'counts')})
                if state.get('checkpoint') and time.monotonic() - checkpoint_at > 4:
                    checkpoint = await self.channel.json(self.workspace, device, 'GET', '/sync/' + identifier + '/result')
                    self.save_snapshot(checkpoint.get('snapshot', checkpoint), account, device, strip_media=True)
                    checkpoint_at = time.monotonic()
                await asyncio.sleep(2)
            else:
                raise ConnectorError(504, '本次同步等待与执行超过 18 分钟，请核对原执行电脑')
            result = await self.channel.json(self.workspace, device, 'GET', '/sync/' + identifier + '/result')
            snapshot = result.get('snapshot', result)
            self.save_snapshot(snapshot, account, device, strip_media=True)
            media_summary = dict(saved=0, cached=0, failed=0, total=sum(len(note.get('mediaAssets', [])) for note in snapshot.get('notes', [])))
            # Archive only verified framed media, within the authenticated account subtree.
            for note in snapshot.get('notes', []):
                if note.get('accountId') != account['id']:
                    raise ConnectorError(403, '内容不属于当前账号')
                assets = []
                for asset in note.get('mediaAssets', []):
                    try:
                        from urllib.parse import unquote
                        relative = asset['path']
                        parts = relative.split('/')
                        if len(parts) != 5 or any(p in ('', '.', '..') for p in parts) or '\\' in relative or unquote(parts[0]) != account['id'] or unquote(parts[3]) != note['id'] or not re.fullmatch(r'[a-f0-9]{32}', asset['id']):
                            raise ConnectorError(403, '无效媒体路径')
                        destination = self.scope.root / 'media' / relative
                        if not destination.resolve().is_relative_to((self.scope.root / 'media').resolve()):
                            raise ConnectorError(403, '媒体路径越界')
                        cached = destination.is_file() and destination.stat().st_size == asset['bytes'] and hashlib.sha256(destination.read_bytes()).hexdigest() == asset['sha256']
                        if not cached:
                            media = await self.channel.request(self.workspace, device, 'GET', '/sync/' + identifier + '/media/' + asset['id'])
                            data = media['data']
                            if media['status'] != 200 or len(data) != asset['bytes'] or hashlib.sha256(data).hexdigest() != asset['sha256']:
                                raise ConnectorError(502, '媒体校验失败，未保存未确认的数据')
                            destination.parent.mkdir(parents=True, exist_ok=True)
                            part = destination.with_name(destination.name + '.' + str(uuid.uuid4()) + '.part')
                            part.write_bytes(data)
                            part.replace(destination)
                        media_summary['cached' if cached else 'saved'] += 1
                        assets.append(asset)
                    except (OSError, ValueError, KeyError):
                        media_summary['failed'] += 1
                note['mediaAssets'] = assets
            self.save_snapshot(snapshot, account, device)
            counts = {key: len(snapshot.get(key, [])) for key in ('notes', 'comments', 'messages')}
            await self.update(identifier, dict(status='partial', stage='finished', counts=counts, media=media_summary, evidence=result.get('evidence'), coverage=result.get('coverage'), message=f'已同步 {counts["notes"]} 篇笔记、{counts["comments"]} 条评论、{counts["messages"]} 条私信；已保存媒体 {media_summary["saved"] + media_summary["cached"]} 个，传输失败 {media_summary["failed"]} 个。尚未证明覆盖全部历史与所有消息类型。', finishedAt=stamp()))
        except asyncio.CancelledError:
            pass
        except Exception as error:
            stopped = False
            try:
                stopped = (await self.channel.json(self.workspace, device, 'POST', '/sync/' + identifier + '/cancel', {})).get('stopConfirmed') is True
            except Exception:
                pass
            await self.update(identifier, dict(status='blocked', stage='blocked', stopConfirmed=stopped, error=str(error), message=str(error), finishedAt=stamp()))

    def save_snapshot(self, snapshot, account, device, strip_media=False):
        from .snapshots import validate_snapshot
        snapshot = validate_snapshot(snapshot)
        current, actual = self.account(account['id']), snapshot.get('account', {})
        if not current or current['profile'] != account['profile'] or actual.get('id') != account['id'] or actual.get('handle') != account['handle'] or actual.get('profile') != account['profile'] or self.channel.binding(self.workspace, account['profile']) != device:
            raise ConnectorError(409, '账号绑定发生变化，结果未保存')
        for kind in ('notes', 'comments', 'messages'):
            items = snapshot.get(kind, [])
            if not isinstance(items, list) or any(item.get('accountId') != account['id'] for item in items):
                raise ConnectorError(403, '内容不属于当前账号')
            if strip_media and kind == 'notes':
                items = [{key: value for key, value in note.items() if key != 'mediaAssets'} for note in items]
            for index in range(0, len(items), 10):
                self.scope.store.import_snapshot(dict(account=actual, notes=[], comments=[], messages=[]) | {kind: items[index:index + 10]})
        if not any(snapshot.get(kind) for kind in ('notes', 'comments', 'messages')):
            self.scope.store.import_snapshot(dict(account=actual, notes=[], comments=[], messages=[]))

    async def cancel(self, identifier):
        job = self.status(identifier)
        if not job:
            return None
        if job['status'] in ('complete', 'partial') or job.get('stopConfirmed'):
            return job
        device = self.channel.binding(self.workspace, job['profile'])
        confirmed = False
        try:
            result = await self.channel.json(self.workspace, device, 'POST', '/sync/' + identifier + '/cancel', {})
            confirmed = result.get('stopConfirmed') is True
        except ConnectorError:
            pass
        task = self.workers.get(identifier)
        if task:
            task.cancel()
        patch = dict(status='blocked', stage='blocked', stopConfirmed=confirmed, message='停止已确认' if confirmed else '停止尚未确认，请保持原执行电脑在线；租约失效后停止后续步骤', finishedAt=stamp())
        if job['status'] == 'blocked' and confirmed:
            job.update(message='停止已确认')
        return await self.update(identifier, patch)

    def _login_path(self, identifier):
        if not re.fullmatch(r'[a-f0-9-]{36}', identifier):
            raise ConnectorError(400, '无效扫码任务')
        return self.scope.root / 'local-logins' / (identifier + '.json')

    def login_read(self, identifier):
        path = self._login_path(identifier)
        if not path.exists():
            raise ConnectorError(400, '扫码任务不属于当前工作区')
        job = json.loads(path.read_text(encoding='utf-8'))
        if job['status'] not in ('cancelled', 'failed', 'authenticated'):
            created = job.get('createdAt', '')
            from datetime import datetime
            if time.time() - datetime.fromisoformat(created.replace('Z', '+00:00')).timestamp() > 900:
                job.update(status='failed', message='扫码任务已过期，请重新发起扫码')
                atomic_json(path, job)
        return job

    def login_latest(self, device=None):
        jobs = [self.login_read(file.stem) for file in (self.scope.root / 'local-logins').glob('*.json') if re.fullmatch(r'[a-f0-9-]{36}', file.stem)]
        return max((j for j in jobs if not device or j.get('deviceId') == device), key=lambda j: j['createdAt'], default=None)

    async def login_start(self, account_id, device):
        async with self.locks.setdefault('login', asyncio.Lock()):
            account = self.account(account_id) if account_id else None
            if account_id and not account:
                raise ConnectorError(400, '目标账号不存在')
            if account and self.busy(account):
                await self.reconcile_stopped_sync(account)
            if account and (self.busy(account) or self.running(account_id)):
                raise ConnectorError(409, '此账号正在执行任务，请先停止同步，再换电脑登录')
            for path in (self.scope.root / 'local-logins').glob('*.json'):
                old = self.login_read(path.stem)
                if old['status'] in ('cancelled', 'failed', 'authenticated'):
                    continue
                if old.get('deviceId') == device:
                    if old.get('accountId') == account_id:
                        return old
                    raise ConnectorError(409, '请先完成或取消当前扫码任务')
                if account_id and old.get('accountId') == account_id:
                    old.update(status='cancelled', message='已在另一台电脑重新发起登录，此次扫码已取消')
                    atomic_json(path, old)
            identifier = str(uuid.uuid4())
            session = hashlib.sha256((str(self.scope.root) + ':' + identifier).encode()).hexdigest()[:48]
            if account and account['profile'].startswith('local:') and self.channel.binding(self.workspace,account['profile'])==device:
                session=account['profile'][6:]
            name = self.channel.pairing.device_by_id(device, self.workspace)['name']
            job = dict(id=identifier, sessionId=session, accountId=account_id, expectedHandle=account['handle'] if account else None, deviceId=device, deviceName=name, status='starting', message='正在打开账号专属登录窗口', createdAt=stamp())
            atomic_json(self._login_path(identifier), job)
            await self.channel.bind(self.workspace, 'local:' + session, device)
            try:
                await self.channel.json(self.workspace, device, 'POST', '/accounts/' + session + '/login')
                job = self.login_read(identifier)
                if job['status'] != 'starting':
                    return job
                job.update(status='waiting_scan', message=f'已在“{name}”打开浏览器登录窗口，请使用小红书 App 扫码')
            except Exception as error:
                job = self.login_read(identifier)
                if job['status'] != 'starting':
                    return job
                job.update(status='failed', message=str(error))
            atomic_json(self._login_path(identifier), job)
            return job

    async def login_status(self, identifier):
        async with self.locks.setdefault('login:' + identifier, asyncio.Lock()):
            job = self.login_read(identifier)
            if job['status'] in ('cancelled', 'failed', 'authenticated'):
                return job | ({'account': self.account(job.get('accountId')), 'accountWritten': False} if job['status'] == 'authenticated' else {})
            info = await self.channel.json(self.workspace, job['deviceId'], 'GET', '/accounts/' + job['sessionId'] + '/state')
            job = self.login_read(identifier)
            if job['status'] in ('cancelled', 'failed', 'authenticated'):
                return job
            if job.get('accountId') and not self.account(job['accountId']):
                job.update(status='cancelled', message='目标账号已删除，扫码已取消')
            else:
                handle, web_handle = str(info.get('handle', info.get('creatorHandle', ''))).strip(), str(info.get('webHandle', '')).strip()
                if info.get('connected') is False:
                    await self.channel.json(self.workspace,job['deviceId'],'POST','/accounts/'+job['sessionId']+'/cancel')
                    job.update(status='failed',message='同步失败：小红书窗口已关闭，请重新点击开始同步。已保存的内容保留。')
                elif not info.get('creatorLoggedIn'):
                    job.update(stage='creator', message='第 1 步：请在弹出的浏览器中扫码登录创作服务平台')
                elif not info.get('webLoggedIn') or not handle or not web_handle:
                    job.update(stage='web', message='第 2 步：请在小红书网页版继续扫码并确认账号编号')
                elif handle.lower() != web_handle.lower():
                    job.update(status='failed', message=f'创作平台账号 {handle} 与网页版账号 {web_handle} 不一致，未修改绑定')
                elif job.get('expectedHandle') and handle.lower() != job['expectedHandle'].lower():
                    job.update(status='failed', message=f'扫码账号 {handle} 与目标 {job["expectedHandle"]} 不一致，未修改绑定')
                elif not info.get('name'):
                    job.update(message='已登录，正在读取账号名称，请保持创作平台首页打开')
                else:
                    old = next((a for a in self.scope.store.list_accounts() if a['handle'].lower() == handle.lower()), {})
                    account = old | dict(id=old.get('id', 'xhs-' + handle), name=info['name'], handle=handle, profile='local:' + job['sessionId'], avatar=old.get('avatar', ''), followers=info.get('followers', old.get('followers', 0)), lastSyncedAt=old.get('lastSyncedAt', ''), state='connected')
                    if self.busy(account):
                        raise ConnectorError(409, '此账号有正在执行的任务')
                    if not old:
                        self.scope.store.add_account(account)
                    self.scope.store.import_snapshot(dict(account=account, notes=[], comments=[]))
                    job.update(accountId=account['id'], status='authenticated', stage='ready', message=f'已绑定 {account["name"]}（{handle}），可以同步草稿和读取内容')
                    atomic_json(self._login_path(identifier), job)
                    return job | {'account': account, 'accountWritten': True}
            atomic_json(self._login_path(identifier), job)
            return job

    async def login_adopt(self, identifier):
        job = self.login_read(identifier)
        if job['status'] != 'failed' or '与目标' not in job['message']:
            raise ConnectorError(400, '此任务不能更换接入目标，请重新扫码')
        job.update(expectedHandle=None, accountId=None, status='waiting_scan')
        atomic_json(self._login_path(identifier), job)
        return await self.login_status(identifier)

    async def login_cancel(self, identifier):
        job = self.login_read(identifier)
        if job['status'] in ('cancelled', 'failed', 'authenticated'):
            return job
        job.update(status='cancelled', stopConfirmed=False, message='已申请取消，停止尚未确认')
        atomic_json(self._login_path(identifier), job)
        try:
            result = await self.channel.json(self.workspace, job['deviceId'], 'POST', '/accounts/' + job['sessionId'] + '/cancel')
            job['stopConfirmed'] = result.get('stopConfirmed') is True
        except ConnectorError:
            pass
        job['message'] = '扫码已取消' if job['stopConfirmed'] else '停止尚未确认，请核对原执行电脑'
        atomic_json(self._login_path(identifier), job)
        return job

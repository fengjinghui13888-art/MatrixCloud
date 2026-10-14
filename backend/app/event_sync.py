"""Persist event hints before ACK; never move an old hint to another computer."""
import asyncio
import json
from .protocols import valid_xhs_event
from .sync import atomic_json, recent_ids
from .gateway import stamp


class EventSync:
    def __init__(self, execution):
        self.execution = execution
        self.scope, self.channel = execution.scope, execution.channel
        self.file = self.scope.root / 'event-sync.json'
        self.lock = asyncio.Lock()
        self.state = json.loads(self.file.read_text(encoding='utf-8')) if self.file.exists() else dict(enabled=True, accounts={})
        if type(self.state.get('enabled')) is not bool or not isinstance(self.state.get('accounts'), dict):
            raise ValueError('事件队列损坏，请先核对记录')
        for record in self.state['accounts'].values():
            if record.get('inflight') and record['status'] == 'running':
                record.update(status='paused', recoveryPending=True, message='服务已重启，原任务结果待核对；不会重复采集')
        self.save()
        execution.on_terminal = self.observe_completion
        execution.on_release = self.drain

    def save(self):
        atomic_json(self.file, self.state)

    def record(self, identifier):
        return self.state['accounts'].setdefault(identifier, dict(status='idle', message='等待浏览器事件', pending=[], eventIds=[]))

    def status(self):
        result = []
        for account in self.scope.store.list_accounts():
            row = self.record(account['id'])
            result.append(dict(accountId=account['id'], status=row['status'], message=row['message'], pendingKinds=list(dict.fromkeys(e['kind'] for e in row['pending']))) | {k: row[k] for k in ('lastEventAt', 'lastSyncedAt', 'job') if k in row})
        return dict(enabled=self.state['enabled'], mode='event', accounts=result)

    async def set_enabled(self, enabled):
        async with self.lock:
            self.state['enabled'] = enabled
            for row in self.state['accounts'].values():
                if not enabled:
                    row['pending'] = []
                    if not row.get('inflight'):
                        row.update(status='idle', message='事件同步已关闭')
                elif row['status'] == 'paused' and row.get('inflight', {}).get('jobId'):
                    job = self.execution.status(row['inflight']['jobId'])
                    if job and job['status'] == 'blocked' and job.get('stopConfirmed') is True and job.get('message') == '停止已确认' and not job.get('error'):
                        row['pending'] = row['inflight']['events'] + row['pending']
                        row.pop('inflight', None)
                        row.update(status='pending', recoveryPending=False)
                elif row['status']=='idle' and not row.get('inflight'):
                    row['message']='等待浏览器变化，收到新互动后自动收录'
            self.save()
        if enabled:
            await self.drain()
        await self.refresh_watches()
        return self.status()

    async def receive(self, incoming):
        async with self.lock:
            event = incoming.get('event')
            if incoming.get('workspace') != self.scope.workspace or not valid_xhs_event(event):
                return False
            account = next((a for a in self.scope.store.list_accounts() if a['profile'] == event['profile']), None)
            if not account or self.channel.binding(self.scope.workspace, account['profile']) != incoming.get('deviceId'):
                return False
            row = self.record(account['id'])
            if event['eventId'] in row['eventIds']:
                return True
            row['eventIds'] = (row['eventIds'] + [event['eventId']])[-256:]
            row['lastEventAt'] = stamp()
            if self.state['enabled'] and row['status'] != 'paused':
                hint = dict(eventId=event['eventId'], kind=event['kind'], workspace=self.scope.workspace, deviceId=incoming['deviceId'], profile=account['profile'], handle=account['handle'])
                source = lambda item: (item['workspace'], item['deviceId'], item['profile'], item['handle'])
                if any(source(item) != source(hint) for item in row['pending']):
                    row.update(status='paused', message='原账号绑定已改变，旧事件不会在新设备执行')
                elif not any(item['kind'] == hint['kind'] for item in row['pending']):
                    row['pending'].append(hint)
                if not row.get('inflight') and row['status'] != 'paused':
                    row['status'] = 'pending'
            self.save()
        asyncio.create_task(self.drain(incoming['deviceId']))
        return True

    async def observe_completion(self, job):
        async with self.lock:
            row = self.state['accounts'].get(job['accountId'])
            if not row or row.get('inflight') and row['inflight'].get('jobId') != job['id']:
                return
            if job['status'] == 'blocked':
                row.update(status='paused', message=job.get('message', '任务失败或停止尚未确认，自动同步已暂停'), job=job)
            elif job['status'] in ('partial', 'complete'):
                row.pop('inflight', None)
                row.update(job=job, lastSyncedAt=job.get('finishedAt', stamp()))
                if row['status'] != 'paused' or row.get('recoveryPending'):
                    row.update(status='pending' if row['pending'] else 'idle', recoveryPending=False, message='等待浏览器事件')
            self.save()
        await self.refresh_watches()
        await self.drain()

    async def drain(self, device=None):
        async with self.lock:
            if not self.state['enabled']:
                return
            for account in self.scope.store.list_accounts():
                row = self.record(account['id'])
                if row.get('inflight'):
                    job = self.execution.status(row['inflight'].get('jobId'))
                    if not job:
                        row.update(status='paused', message='找不到任务的可靠执行结果，自动同步已暂停')
                    elif job['status'] == 'blocked':
                        row.update(status='paused', message=job.get('message', '任务失败或停止尚未确认，自动同步已暂停'), job=job)
                    elif job['status'] in ('complete', 'partial'):
                        row.pop('inflight', None)
                        row.update(job=job, lastSyncedAt=job.get('finishedAt', stamp()))
                        if row['status'] != 'paused' or row.get('recoveryPending'):
                            row.update(status='pending' if row['pending'] else 'idle', recoveryPending=False, message='等待浏览器事件')
                    self.save()
                    if row.get('inflight'):
                        continue
                if not row['pending'] or row['status'] == 'paused':
                    continue
                hint = row['pending'][0]
                if hint['workspace'] != self.scope.workspace or hint['profile'] != account['profile'] or hint['handle'] != account['handle'] or self.channel.binding(self.scope.workspace, account['profile']) != hint['deviceId']:
                    row.update(status='paused', message='原账号绑定已改变，旧事件不会在新设备执行')
                    self.save()
                    continue
                if device and device != hint['deviceId']:
                    continue
                if not await self.channel.online(hint['deviceId']):
                    row.update(status='offline', message='原执行电脑离线，事件已保存')
                    self.save()
                    continue
                if self.execution.busy(account) or self.execution.running(account['id']):
                    row.update(status='busy', message='等待已有任务结束，事件已合并')
                    self.save()
                    continue
                try:
                    health = await self.channel.json(self.scope.workspace, hint['deviceId'], 'GET', '/verify')
                    if not all(c in health.get('capabilities', []) for c in ('event-sync', 'stop-ack')):
                        row.update(status='paused', message='请更新执行电脑连接器后再启用事件同步')
                        self.save()
                        continue
                    identity = await self.channel.json(self.scope.workspace, hint['deviceId'], 'GET', '/accounts/' + account['profile'][6:] + '/state')
                    if not identity.get('creatorLoggedIn') or not identity.get('webLoggedIn') or str(identity.get('handle', identity.get('creatorHandle', ''))).lower() != account['handle'].lower() or str(identity.get('webHandle', '')).lower() != account['handle'].lower():
                        row.update(status='paused', message='账号登录身份未核验，自动同步已暂停')
                        self.save()
                        continue
                except Exception:
                    row.update(status='offline', message='原执行电脑状态未确认，事件保留等待重连')
                    self.save()
                    continue
                events, row['pending'] = row['pending'], []
                row.update(inflight={'events': events}, status='running', message='正在启动事件增量同步')
                self.save()
                try:
                    job = await self.execution.start(account['id'], account['profile'], dict(mode='incremental', source='event', eventKinds=list(dict.fromkeys(e['kind'] for e in events)), eventDeviceId=hint['deviceId'], expectedHandle=hint['handle']))
                    row['inflight']['jobId'] = job['id']
                    row['job'] = job
                except Exception as error:
                    row.update(status='paused', message=str(error))
                self.save()

    async def refresh_watches(self):
        groups = {}
        for account in self.scope.store.list_accounts():
            device = self.channel.binding(self.scope.workspace, account['profile'])
            if not device:
                continue
            items = groups.setdefault(device, [])
            if self.state['enabled'] and self.record(account['id'])['status'] != 'paused':
                items.append(dict(profile=account['profile'], accountId=account['id'], handle=account['handle'], knownNotes=recent_ids(self.scope.store.list_notes({'accountId': account['id']}), 'publishedAt'), knownComments=recent_ids(self.scope.store.list_comments({'accountId': account['id']})), knownMessages=recent_ids(self.scope.store.list_messages({'accountId': account['id']}))))
        for device, items in groups.items():
            if len(items) > 100 or len(json.dumps(items).encode()) > 8 * 1024 * 1024 - 1024:
                for item in items:
                    self.record(item['accountId']).update(status='paused', message='此设备的事件订阅超过容量限制，事件同步已暂停')
                items = []
            try:
                await self.channel.watch(device, items)
            except Exception as error:
                for item in items:
                    row = self.record(item['accountId'])
                    if row['status'] != 'paused':
                        row.update(status='offline', message='事件观察订阅未送达：' + str(error))
            self.save()

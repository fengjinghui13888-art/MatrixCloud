"""Protocol 4 wire contracts. Cloud commands never accept executable code."""
from __future__ import annotations
import re
from typing import Any

PROTOCOL_VERSION = 4
CONNECTOR_VERSION = '4.0.0'
CAPABILITIES = ['account-sync', 'studio-drafts', 'device-queue', 'stop-ack', 'passive-state', 'paced-actions', 'reconnect', 'event-sync']
MAX_RPC_ACTIVE = 8
MAX_RPC_BYTES = 64 * 1024 * 1024
RPC_CHUNK_BYTES = 48 * 1024
MAX_WS_BYTES = 8 * 1024 * 1024
CONNECTOR_PLATFORMS = [
    dict(id='windows', label='Windows x64（10/11）', filename='matrix-cloud-windows-connector.zip', source='windows-connector'),
    dict(id='mac-arm64', label='Mac Apple 芯片（macOS 11+）', filename='matrix-cloud-mac-apple-silicon-connector.zip', source='mac-connector-arm64'),
    dict(id='mac-intel', label='Mac Intel（macOS 11+）', filename='matrix-cloud-mac-intel-connector.zip', source='mac-connector-x64'),
    dict(id='windows-arm64', label='Windows ARM64（10/11）', filename='matrix-cloud-windows-arm64-connector.zip', source='windows-connector-arm64'),
    dict(id='windows-x86', label='Windows 32位（10）', filename='matrix-cloud-windows-x86-connector.zip', source='windows-connector-x86'),
    dict(id='linux-x64', label='Linux x64（glibc 2.28+）', filename='matrix-cloud-linux-x64-connector.zip', source='linux-connector-x64'),
    dict(id='linux-arm64', label='Linux ARM64（glibc 2.28+）', filename='matrix-cloud-linux-arm64-connector.zip', source='linux-connector-arm64'),
]
_MISSING = object()
OMITTED = _MISSING
def _match(pattern: str, value: Any, flags: int = 0) -> bool:
    return isinstance(value, str) and re.fullmatch(pattern, value, flags) is not None
def valid_profile(value: Any) -> bool:
    return _match(r'local:[\w-]{1,100}', value, re.ASCII)
def valid_id(value: Any) -> bool:
    return _match(r'[a-zA-Z0-9_-]{1,100}', value)
def valid_uuid(value: Any) -> bool:
    return _match(r'[a-f0-9-]{36}', value, re.I)
def valid_connector_command(method: str, path: str, body: Any = _MISSING) -> bool:
    if not isinstance(method,str) or not isinstance(path,str): return False
    if method == 'GET' and path == '/verify': return True
    if method == 'POST' and path == '/cleanup':
        return isinstance(body, dict) and set(body) <= {'manifestId'} and ('manifestId' not in body or _match(r'[a-f0-9-]{36}', body['manifestId']))
    account = re.fullmatch(r'/accounts/([a-zA-Z0-9_-]{1,100})/(login|state|image|remove|cancel|resume|safety|drafts)', path)
    if account:
        action = account[2]
        if action == 'drafts':
            return method=='POST' and isinstance(body,dict) and set(body)=={'title','draftId','handle'} and valid_uuid(body.get('draftId')) and all(isinstance(body.get(k),str) and 0<len(body[k])<=256 for k in ('title','handle'))
        if action == 'resume': return method == 'POST' and isinstance(body, dict) and body.get('confirmed') is True
        return method == ('GET' if action in ('state','image','safety') else 'POST') and body is _MISSING
    if method == 'POST' and path == '/studio':
        return isinstance(body, dict) and valid_uuid(body.get('runId')) and valid_uuid(body.get('taskId')) and valid_profile(body.get('profile'))
    if re.fullmatch(r'/studio/[a-f0-9-]{36}/cancel', path, re.I): return method == 'POST'
    if re.fullmatch(r'/studio/[a-f0-9-]{36}', path, re.I): return method == 'GET'
    sync = re.fullmatch(r'/sync/([a-f0-9-]{36})(?:/(result|cancel|media)(?:/([a-f0-9]{32}))?)?', path)
    if not sync: return False
    if sync[2] == 'media': return method == 'GET' and bool(sync[3])
    if sync[2] == 'cancel': return method == 'POST'
    if sync[2] == 'result': return method == 'GET'
    target = body.get('target') if isinstance(body, dict) else None
    return method == 'GET' or (method == 'POST' and isinstance(target, dict) and valid_profile(target.get('profile')) and isinstance(target.get('id'), str) and isinstance(body.get('knownNotes'), list))
validate_rpc = valid_connector_command
def valid_xhs_event(event: Any) -> bool:
    return isinstance(event, dict) and set(event) <= {'eventId','profile','kind','fingerprint'} and _match(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', event.get('eventId'), re.I) and valid_profile(event.get('profile')) and event.get('kind') in ('notes','comments','messages') and _match(r'[a-f0-9]{64}', event.get('fingerprint'))
def valid_xhs_subscriptions(items: Any) -> bool:
    text = lambda v: isinstance(v, str) and 0 < len(v) <= 256
    return isinstance(items, list) and len(items) <= 100 and all(isinstance(item, dict) and valid_profile(item.get('profile')) and text(item.get('accountId')) and text(item.get('handle')) and ('enabled' not in item or isinstance(item['enabled'], bool)) and all(isinstance(item.get(k), list) and len(item[k]) <= 10000 and all(text(v) for v in item[k]) for k in ('knownNotes','knownComments','knownMessages')) for item in items)

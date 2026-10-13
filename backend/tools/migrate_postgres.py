"""Explicit offline SQLite -> normalized PostgreSQL v2 migration. Never run on import."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def read_rows(path, table):
    if not Path(path).is_file():
        return []
    if not re.fullmatch('[a-z_]+', table):
        raise ValueError('不安全的数据表名')
    with closing(sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)) as connection:
        connection.row_factory = sqlite3.Row
        exists = connection.execute('SELECT 1 FROM sqlite_master WHERE type=? AND name=?', ('table', table)).fetchone()
        return [dict(row) for row in connection.execute(f'SELECT * FROM {table}')] if exists else []


def stable(value):
    if isinstance(value, list):
        return sorted((stable(item) for item in value), key=encoded)
    if isinstance(value, dict):
        return {key: stable(value[key]) for key in sorted(value)}
    return value


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(encoded(stable(value)).encode('utf-8')).hexdigest()


def legacy_auth(source):
    file = Path(source) / 'accounts.sqlite'
    users = read_rows(file, 'login_users') + read_rows(file, 'auth_members')
    administrators = read_rows(file, 'administrator')
    by_name = {user['username']: user for user in users}
    for user in administrators:
        by_name.setdefault(user['username'], {**user, 'workspace': 'owner', 'display_name': user['username']})
    if len(by_name) != len(users) + sum(user['username'] not in {item['username'] for item in users} for user in administrators):
        raise ValueError('旧账号表存在重复用户名，停止迁移')
    metadata = {row['username']: row for row in read_rows(file, 'auth_user_metadata')}
    users = [{**user, 'role': metadata.get(name, {}).get('role', 'admin'), 'enabled': bool(metadata.get(name, {}).get('enabled', 1))} for name, user in by_name.items()]
    links = {row['session_hash']: row['username'] for row in read_rows(file, 'session_users')}
    if len(administrators) == 1:
        for session in read_rows(file, 'sessions'):
            links.setdefault(session['hash'], administrators[0]['username'])
    return users, read_rows(file, 'auth_tenants'), links


def migrate(source, url, *, initialize=False, app_role='matrix_app'):
    import psycopg
    from psycopg.rows import dict_row
    from psycopg import sql
    from app.store import EMPTY, Store
    from app.postgres import Postgres, PostgresStore
    from app.models import decode_cipher, encode_cipher
    source = Path(source).resolve()
    if not source.is_dir() or not url:
        raise ValueError('需要现有数据目录和迁移数据库凭证')
    if not re.fullmatch('[a-zA-Z_][a-zA-Z0-9_]*', app_role):
        raise ValueError('无效应用数据库角色')
    users, tenant_metadata, links = legacy_auth(source)
    tenants = {user['workspace']: user.get('display_name') or user['username'] for user in users}
    tenants.setdefault('owner', '平台工作区')
    tenant_metadata = {row['id']: row for row in tenant_metadata}
    tenants.update({tenant: row['name'] for tenant, row in tenant_metadata.items()})
    report = {'schema': 2, 'tenants': [], 'devices': 0, 'verified': False}
    # Schema creation is explicit and uses migration-owner credentials; the web app never does DDL.
    if initialize:
        with psycopg.connect(url, autocommit=True) as connection:
            connection.execute((BACKEND / 'sql' / 'postgres-schema.sql').read_text(encoding='utf-8'))
    db = Postgres(url)
    try:
        with psycopg.connect(url, row_factory=dict_row) as connection, connection.transaction():
            connection.execute("SELECT pg_advisory_xact_lock(hashtext('matrix-offline-migration'))")
            current = {row['tenant_id'] for row in connection.execute('SELECT tenant_id FROM tenant')}
            folders = source / 'workspaces'
            if folders.is_dir():
                for folder in folders.iterdir():
                    if re.fullmatch('[a-f0-9-]{36}', folder.name) and folder.name not in tenants and folder.name not in current:
                        raise ValueError('发现无所属用户的工作区，停止迁移')
            done = {row['tenant_id'] for row in connection.execute('SELECT tenant_id FROM legacy_migration')}
            for tenant, name in tenants.items():
                connection.execute('INSERT INTO tenant(tenant_id,name,enabled) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING', (tenant, name, bool(tenant_metadata.get(tenant, {}).get('enabled', 1))))
            for user in users:
                if user['workspace'] not in done:
                    existing = connection.execute('SELECT tenant_id FROM app_user WHERE username=%s', (user['username'],)).fetchone()
                    if existing:
                        raise ValueError('目标已存在同名账号，拒绝混合旧新账号')
                    connection.execute('INSERT INTO app_user(tenant_id,username,password_hash,password_salt,display_name,role,enabled) VALUES(%s,%s,%s,%s,%s,%s,%s)',
                                       (user['workspace'], user['username'], user['hash'], user['salt'], user.get('display_name') or user['username'], user['role'], user['enabled']))
            by_username = {user['username']: user for user in users}
            for session in read_rows(source / 'accounts.sqlite', 'sessions'):
                user = by_username.get(links.get(session['hash']))
                if user and user['workspace'] not in done and session['expires'] > time.time() * 1000:
                    connection.execute('INSERT INTO login_session VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING', (session['hash'], user['workspace'], user['username'], session['expires']))
            for tenant in tenants:
                connection.execute("SELECT set_config('app.tenant_id',%s,true)", (tenant,))
                root = source if tenant == 'owner' else source / 'workspaces' / tenant
                saved = read_rows(root / 'operations.sqlite', 'operations_state')
                state = json.loads(saved[0]['payload']) if saved else json.loads(json.dumps(EMPTY))
                state.setdefault('messages', [])
                if state.get('templates'):
                    raise ValueError('旧业务模板未关联模板库，需核对后迁移')
                for comment in state['comments']:
                    if comment['status'] == 'lead_created' and not any(lead['sourceCommentId'] == comment['id'] for lead in state['leads']):
                        comment['status'] = 'pending'
                Store._validate(state)
                if tenant in done:
                    previous = connection.execute('SELECT source_hash FROM legacy_migration WHERE tenant_id=%s', (tenant,)).fetchone()
                    if previous['source_hash'] != digest(state):
                        raise ValueError('旧数据在迁移后发生变化，拒绝覆盖新数据库')
                    report['tenants'].append({'tenant': tenant, 'alreadyMigrated': True})
                    continue
                target = PostgresStore(db, tenant)
                before = target._load(connection)
                if any(before.get(key) for key in EMPTY):
                    raise ValueError('目标租户非空，拒绝覆盖')
                if connection.execute('SELECT 1 FROM generation WHERE tenant_id=%s UNION ALL SELECT 1 FROM template WHERE tenant_id=%s UNION ALL SELECT 1 FROM model_config WHERE tenant_id=%s LIMIT 1', (tenant, tenant, tenant)).fetchone():
                    raise ValueError('目标任务、模板或模型配置非空，拒绝覆盖')
                # Preserve historical member IDs in lead ownership. Runtime assignment
                # checks current enabled users, while offline migration preserves records.
                without_leads = {**state, 'leads': [], 'followUps': []}
                target._persist(connection, before, without_leads)
                for lead in state['leads']:
                    connection.execute('INSERT INTO clue(tenant_id,id,account_id,source_note_id,source_comment_id,status,level,owner_id,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                                       (tenant, lead['id'], lead['accountId'], lead['sourceNoteId'], lead['sourceCommentId'], lead['status'], lead['level'], lead.get('ownerId'), lead['createdAt']))
                for follow in state['followUps']:
                    connection.execute('INSERT INTO follow_up VALUES(%s,%s,%s,%s,%s,%s)', (tenant, follow['id'], follow['leadId'], follow['body'], follow['author'], follow['createdAt']))
                actual = target._load(connection)
                manifest = {key: {'count': len(value), 'sha256': digest(value)} for key, value in state.items() if key != 'templates'}
                for key in manifest:
                    if digest(actual[key]) != manifest[key]['sha256']:
                        raise ValueError(f'迁移数据核对失败：{tenant}/{key}')
                counts = {}
                for file, table, kind in (('studio.sqlite', 'studio_tasks', 'studio'), ('creation.sqlite', 'creation_tasks', 'creation'), ('publish.sqlite', 'publish_queue', 'publish')):
                    tasks = [json.loads(row['payload']) for row in read_rows(root / file, table)]
                    counts[kind] = len(tasks)
                    for task in tasks:
                        if task['status'] in ('generating', 'running', 'approved', 'filling', 'pending_confirmation'):
                            raise ValueError('迁移前必须停止或处理执行中的任务')
                        connection.execute('INSERT INTO generation(tenant_id,id,request_id,account_id,kind,revision,status,payload,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)',
                                           (tenant, task['id'], task.get('requestId'), task.get('accountId'), kind, task.get('revision', 1), task['status'], encoded(task), task['createdAt']))
                    returned = [row['payload'] for row in connection.execute('SELECT payload FROM generation WHERE tenant_id=%s AND kind=%s', (tenant, kind))]
                    if digest(returned) != digest(tasks):
                        raise ValueError('任务迁移核对失败')
                templates = read_rows(root / 'templates.sqlite', 'template_library')
                for row in templates:
                    connection.execute('INSERT INTO template VALUES(%s,%s,%s,%s,%s::jsonb)', (tenant, row['id'], row['fingerprint'], row['revision'], row['payload']))
                returned = [{'id': row['id'], 'fingerprint': row['fingerprint'], 'revision': row['revision'], 'payload': row['payload']} for row in connection.execute('SELECT id,fingerprint,revision,payload FROM template WHERE tenant_id=%s', (tenant,))]
                normalized = [{**row, 'payload': json.loads(row['payload'])} for row in templates]
                if digest(returned) != digest(normalized):
                    raise ValueError('模板迁移核对失败')
                profiles = []
                if (root / 'model-settings.enc').is_file():
                    key = (root / 'model-encryption-key').read_bytes()
                    settings = decode_cipher(key, (root / 'model-settings.enc').read_text(encoding='utf-8'))
                    collection = settings if 'profiles' in settings else {'activeId': 'default', 'profiles': [{'id': 'default', 'settings': settings}]}
                    profiles = collection['profiles']
                    for profile in profiles:
                        connection.execute('INSERT INTO model_config(tenant_id,id,label,active,ciphertext) VALUES(%s,%s,%s,%s,%s)',
                                           (tenant, profile['id'], profile['settings'].get('label'), profile['id'] == collection['activeId'], encode_cipher(key, profile['settings'])))
                    returned = [{'id': row['id'], 'settings': decode_cipher(key, row['ciphertext'])} for row in connection.execute('SELECT id,ciphertext FROM model_config WHERE tenant_id=%s', (tenant,))]
                    if digest(returned) != digest(profiles):
                        raise ValueError('模型密文迁移核对失败')
                for path in (root / 'xhs-sync').glob('*.json'):
                    if not re.fullmatch(r'[a-f0-9-]{36}\.json', path.name):
                        continue
                    job = json.loads(path.read_text(encoding='utf-8'))
                    if job['status'] in ('running', 'queued', 'stopping'):
                        raise ValueError('迁移前必须停止同步任务')
                    connection.execute("INSERT INTO job(tenant_id,id,account_id,kind,status,payload,created_at) VALUES(%s,%s,%s,'sync',%s,%s::jsonb,%s)", (tenant, job['id'], job['accountId'], job['status'], encoded(job), job['startedAt']))
                connection.execute('INSERT INTO legacy_migration VALUES(%s,%s,%s::jsonb,now())', (tenant, digest(state), encoded({**manifest, 'tasks': counts, 'models': len(profiles)})))
                for audit in read_rows(source / 'accounts.sqlite', 'auth_audit'):
                    if audit['workspace'] == tenant:
                        connection.execute('INSERT INTO audit_log(tenant_id,actor,action,target,result,created_at) VALUES(%s,%s,%s,%s,%s,%s)', (tenant, audit['actor'], audit['action'], audit['target'], audit['result'], audit['created_at']))
                report['tenants'].append({'tenant': tenant, 'manifest': manifest, 'tasks': counts, 'models': len(profiles)})
            if not (source / 'postgres-active').exists():
                pairing = source / 'connector-pairing.sqlite'
                layouts = (
                    ('connector_devices', 'device', ('workspace', 'id', 'name', 'platform', 'version', 'token_hash', 'created_at', 'last_seen_at', 'revoked_at')),
                    ('connector_pairings', 'device_pairing', ('workspace', 'id', 'code_hash', 'expires_at', 'status', 'device_id', 'created_at')),
                    ('connector_bindings', 'device_binding', ('workspace', 'profile', 'device_id')),
                    ('connector_selections', 'device_selection', ('workspace', 'device_id')),
                    ('connector_runs', 'device_run', ('workspace', 'id', 'device_id', 'profile', 'kind')))
                for old, new, fields in layouts:
                    for row in read_rows(pairing, old):
                        connection.execute("SELECT set_config('app.tenant_id',%s,true)", (row['workspace'],))
                        placeholders = ','.join(['%s'] * len(fields))
                        connection.execute(f'INSERT INTO {new} VALUES({placeholders}) ON CONFLICT DO NOTHING', tuple(row[field] for field in fields))
                        report['devices'] += int(new == 'device')
            if not connection.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (app_role,)).fetchone():
                raise ValueError('应用数据库角色尚未创建')
            role = sql.Identifier(app_role)
            for statement in ('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {}', 'GRANT USAGE ON SCHEMA public TO {}',
                              'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO {}',
                              'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO {}',
                              'REVOKE UPDATE,DELETE ON audit_log FROM {}',
                              'REVOKE INSERT,UPDATE,DELETE ON schema_migration,legacy_migration FROM {}'):
                connection.execute(sql.SQL(statement).format(role))
            connection.execute('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
        report['verified'] = True
        return report
    finally:
        db.close()


def main():
    import argparse
    from app.settings import Settings, load_env_file
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--offline-confirmed', action='store_true', required=True)
    parser.add_argument('--initialize-schema', action='store_true')
    parser.add_argument('--app-role', default='matrix_app')
    args = parser.parse_args()
    load_env_file()
    print(json.dumps(migrate(args.source, Settings.from_env().database_url, initialize=args.initialize_schema, app_role=args.app_role), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

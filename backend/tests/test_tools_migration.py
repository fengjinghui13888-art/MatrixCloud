from contextlib import closing
import sqlite3

import pytest

from tools.migrate_postgres import digest, read_rows, legacy_auth


def test_migration_hash_is_order_insensitive_but_content_sensitive():
    assert digest([{'title': '原图', 'id': 1}, {'id': 2}]) == digest([{'id': 2}, {'id': 1, 'title': '原图'}])
    assert digest([{'title': '原图', 'id': 1}]) != digest([{'title': '改图', 'id': 1}])


def test_legacy_reads_are_readonly_and_close_windows_handles(tmp_path):
    source = tmp_path / 'operations.sqlite'
    with closing(sqlite3.connect(source)) as connection, connection:
        connection.execute('CREATE TABLE operations_state(id INTEGER,payload TEXT)')
        connection.execute('INSERT INTO operations_state VALUES(1,?)', ('{}',))
    assert read_rows(source, 'operations_state') == [{'id': 1, 'payload': '{}'}]
    with pytest.raises(ValueError):
        read_rows(source, 'operations_state; DROP TABLE operations_state')
    source.unlink()
    assert read_rows(tmp_path / 'missing.sqlite', 'operations_state') == []


def test_legacy_administrator_sessions_roles_and_disabled_tenants_survive(tmp_path):
    with closing(sqlite3.connect(tmp_path / 'accounts.sqlite')) as connection, connection:
        connection.executescript('''
CREATE TABLE administrator(id INTEGER,username TEXT,salt TEXT,hash TEXT);
INSERT INTO administrator VALUES(1,'owner-user','salt','existing-hash');
CREATE TABLE sessions(hash TEXT,expires INTEGER);
INSERT INTO sessions VALUES('session-hash',9999999999999);
CREATE TABLE auth_members(username TEXT,salt TEXT,hash TEXT,workspace TEXT,display_name TEXT);
INSERT INTO auth_members VALUES('reader','salt','reader-hash','owner','读者');
CREATE TABLE auth_user_metadata(username TEXT,role TEXT,enabled INTEGER);
INSERT INTO auth_user_metadata VALUES('reader','lead_viewer',0);
CREATE TABLE auth_tenants(id TEXT,name TEXT,enabled INTEGER,created_at TEXT);
INSERT INTO auth_tenants VALUES('owner','原工作区',0,'2026-01-01');
''')
    users, tenants, links = legacy_auth(tmp_path)
    assert next(user for user in users if user['username'] == 'owner-user')['hash'] == 'existing-hash'
    assert next(user for user in users if user['username'] == 'reader')['enabled'] is False
    assert next(user for user in users if user['username'] == 'reader')['role'] == 'lead_viewer'
    assert tenants[0]['enabled'] == 0
    assert links == {'session-hash': 'owner-user'}

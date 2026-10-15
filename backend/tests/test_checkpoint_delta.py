from copy import deepcopy
from types import SimpleNamespace
import pytest
from app.sync import WorkspaceExecution
from app.gateway import ExecutionGrants


def test_checkpoint_import_skips_unchanged_rows_and_imports_real_changes(tmp_path):
    account=dict(id='a',name='Synthetic',handle='42',profile='local:a',avatar='',followers=1,lastSyncedAt='',state='connected')
    imported=[]
    scope=SimpleNamespace(root=tmp_path,workspace='fixture',store=SimpleNamespace(list_accounts=lambda:[account],import_snapshot=lambda row:imported.append(deepcopy(row))))
    channel=SimpleNamespace(binding=lambda *a:'device')
    execution=WorkspaceExecution(scope,channel,ExecutionGrants(),'')
    notes=[dict(id=str(i),accountId='a',title='Synthetic',summary='body',cover=None,url=None,publishedAt='',metrics=dict(likes=0,collects=0,comments=0,shares=0)) for i in range(34)]
    snapshot=dict(account=account,notes=notes,comments=[],messages=[])
    seen={}
    execution.save_snapshot(snapshot,account,'device',seen=seen)
    for _ in range(8):execution.save_snapshot(snapshot,account,'device',seen=seen)
    assert sum(len(row['notes']) for row in imported)==34
    snapshot['notes'][7]['summary']='changed body'
    execution.save_snapshot(snapshot,account,'device',seen=seen)
    assert sum(len(row['notes']) for row in imported)==35
    assert imported[-1]['notes'][0]['id']=='7'
    # A new sync job gets a fresh tracking map and can restore removed rows.
    execution.save_snapshot(snapshot,account,'device',seen={})
    assert sum(len(row['notes']) for row in imported)==69


def test_failed_checkpoint_write_is_not_marked_successful(tmp_path):
    account=dict(id='a',name='Synthetic',handle='42',profile='local:a',avatar='',followers=1,lastSyncedAt='',state='connected')
    attempts=[]
    def store(row):
        attempts.append(row)
        if len(attempts)==1:raise RuntimeError('database unavailable')
    scope=SimpleNamespace(root=tmp_path,workspace='fixture',store=SimpleNamespace(list_accounts=lambda:[account],import_snapshot=store))
    execution=WorkspaceExecution(scope,SimpleNamespace(binding=lambda *a:'device'),ExecutionGrants(),'')
    snapshot=dict(account=account,notes=[],comments=[],messages=[dict(id='m',accountId='a',conversationId='c',author='Synthetic',body='Hello',createdAt='',direction='incoming')])
    seen={}
    with pytest.raises(RuntimeError):execution.save_snapshot(snapshot,account,'device',seen=seen)
    assert not seen
    execution.save_snapshot(snapshot,account,'device',seen=seen)
    assert len(attempts)==2 and seen

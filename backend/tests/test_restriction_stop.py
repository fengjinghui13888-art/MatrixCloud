from types import SimpleNamespace
import pytest
from connector.browser import BrowserConnection
from connector.safety import ExecutionGuard


@pytest.mark.parametrize('status',[400,401,403,429,451,461,471])
def test_rejected_platform_response_persists_pause_without_retry(tmp_path,status):
    guard=ExecutionGuard(tmp_path,'local:a')
    connection=BrowserConnection(None,SimpleNamespace(on=lambda *a:None),None,guard)
    connection.on_response(SimpleNamespace(url='https://edith.xiaohongshu.com/api/unknown',status=status,headers={}))
    assert guard.status()['state']=='paused'
    with pytest.raises(ValueError):guard.check()


def test_external_site_error_and_missing_asset_do_not_mark_account_restricted(tmp_path):
    guard=ExecutionGuard(tmp_path,'local:a')
    connection=BrowserConnection(None,SimpleNamespace(on=lambda *a:None),None,guard)
    connection.on_response(SimpleNamespace(url='https://example.com',status=403,headers={}))
    connection.on_response(SimpleNamespace(url='https://www.xiaohongshu.com/favicon.ico',status=404,headers={}))
    assert guard.status()['state']=='normal'

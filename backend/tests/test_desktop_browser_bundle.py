import json
from pathlib import Path
import pytest
from test_client_install import bundle
from tools import build_desktop_client as builder


def test_complete_client_includes_validated_browser_and_blocks_missing_runtime(tmp_path,monkeypatch):
    source=bundle(tmp_path);releases=tmp_path/'releases';(releases/'packages').mkdir(parents=True)
    envelope=json.loads((source/'seed.json').read_text());revision=envelope['manifest']['revision']
    (releases/'manifest.json').write_text(json.dumps(envelope))
    (releases/'packages'/f'{revision}.zip').write_bytes((source/'seed.zip').read_bytes())
    key=json.loads((source/'client-config.json').read_text())['publicKey']
    browser_root=tmp_path/'browser-source';exe=browser_root/'chromium-123/chrome-win64/chrome.exe';exe.parent.mkdir(parents=True);exe.write_bytes(b'fixture')
    calls=[]
    monkeypatch.setattr(builder.sys,'platform','win32')
    monkeypatch.setattr(builder.subprocess,'run',lambda command,**kwargs:calls.append(command))
    out=tmp_path/'output'
    result=builder.build(releases,out,'http://127.0.0.1:5173',key,browser_source=browser_root)
    assert result['includesExecutionBrowser'] is True and result['productionReady'] is False
    assert (out/'browsers/chromium-123/chrome-win64/chrome.exe').read_bytes()==b'fixture'
    assert len(calls)==1 and 'PyInstaller' in calls[0]
    assert str(out.resolve()/'browsers')+':browsers' in calls[0]
    assert 'connector.execution_browser' in calls[0]
    calls.clear()
    with pytest.raises(ValueError,match='不完整'):
        builder.build(releases,tmp_path/'bad-output','http://127.0.0.1:5173',key,browser_source=tmp_path/'missing')
    assert not calls

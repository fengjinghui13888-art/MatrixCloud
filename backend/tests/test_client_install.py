import json
from pathlib import Path
import pytest
from test_client_updates import release,public
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from client.entry import install


def bundle(tmp_path):
    key=Ed25519PrivateKey.generate();envelope,blob=release(key)
    source=tmp_path/'bundle';source.mkdir();(source/'seed.json').write_text(json.dumps(envelope));(source/'seed.zip').write_bytes(blob);(source/'client-config.json').write_text(json.dumps({'publicKey':public(key),'cloudUrl':'https://workspace.example'}))
    return source


def test_first_install_and_relaunch_preserve_private_data(tmp_path):
    source=bundle(tmp_path);data=tmp_path/'data';data.mkdir();(data/'connector-token').write_text('existing-private-token')
    config=install(source,tmp_path/'installed',data_root=data)
    assert install(source,tmp_path/'installed',data_root=data)==config
    assert (data/'connector-token').read_text()=='existing-private-token'
    assert json.loads(config.read_text())['dataRoot']==str(data.resolve())


def test_install_cannot_silently_change_trust_or_cloud(tmp_path):
    source=bundle(tmp_path);install(source,tmp_path/'installed',data_root=tmp_path/'data')
    value=json.loads((source/'client-config.json').read_text());value['cloudUrl']='https://different.example';(source/'client-config.json').write_text(json.dumps(value))
    with pytest.raises(ValueError):install(source,tmp_path/'installed',data_root=tmp_path/'data')


def test_client_data_and_code_are_not_allowed_to_overlap(tmp_path):
    with pytest.raises(ValueError):install(bundle(tmp_path),tmp_path/'shared',data_root=tmp_path/'shared')


def test_embedded_seed_remains_installable_after_network_manifest_expiry(tmp_path,monkeypatch):
    import client.updates as updates
    source=bundle(tmp_path);expiry=json.loads((source/'seed.json').read_text())['manifest']['expires']
    monkeypatch.setattr(updates.time,'time',lambda:expiry+86400)
    config=install(source,tmp_path/'installed',data_root=tmp_path/'data')
    assert config.exists()

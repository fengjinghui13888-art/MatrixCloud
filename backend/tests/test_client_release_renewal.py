import json
import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from client.updates import UpdateStore,fetch_update
from tools.build_client_release import build,renew


def test_renewal_preserves_code_and_does_not_restart_installed_client(tmp_path,monkeypatch):
    source=tmp_path/'source';(source/'connector').mkdir(parents=True);(source/'app').mkdir()
    for name in ('__init__.py','__main__.py'):(source/'connector'/name).write_text('')
    (source/'app/protocols.py').write_text('PROTOCOL_VERSION=4')
    key=Ed25519PrivateKey.generate();key_file=tmp_path/'private.key';key_file.write_bytes(key.private_bytes(serialization.Encoding.Raw,serialization.PrivateFormat.Raw,serialization.NoEncryption()))
    output=tmp_path/'release';result=build(output,key_file,1,source=source);blob=(output/'packages/1.zip').read_bytes();envelope=json.loads((output/'manifest.json').read_text())
    store=UpdateStore(tmp_path/'installed',result['publicKey']);store.stage(envelope,blob);store.activate(1);store.confirm(1)
    monkeypatch.setattr('time.time',lambda:envelope['manifest']['expires']+86400)
    renewed=renew(output,key_file);assert not renewed['codeChanged'] and renewed['revision']==1
    assert (output/'packages/1.zip').read_bytes()==blob
    requests=[]
    def handler(request):requests.append(request.url.path);return httpx.Response(200,json=json.loads((output/'manifest.json').read_text()))
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:assert fetch_update(store,'https://workspace.example',client) is None
    assert requests==['/api/connector/client/manifest'] and store.state()['current']==1 and store.state()['pending'] is None

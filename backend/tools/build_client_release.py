"""Publish signed connector code; signing keys never enter distributable files."""
from pathlib import Path
import argparse
import hashlib
import io
import json
import os
import sys
import time
import zipfile
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

BACKEND=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BACKEND))
from client.updates import canonical,RUNTIME_ABI,atomic_json


def create_key(destination):
    destination=Path(destination);destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    key=Ed25519PrivateKey.generate()
    with destination.open('xb') as out:os.chmod(destination,0o600);out.write(key.private_bytes(serialization.Encoding.Raw,serialization.PrivateFormat.Raw,serialization.NoEncryption()))
    return key.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw).hex()


def build(output,key_file,revision,expires_days=30,source=BACKEND):
    key=Ed25519PrivateKey.from_private_bytes(Path(key_file).read_bytes());output=Path(output);output.mkdir(parents=True,exist_ok=True)
    path=output/'packages'/f'{revision}.zip'
    if path.exists():raise ValueError('发行版本已存在，不可覆盖已签名版本')
    files={p.relative_to(source).as_posix():p.read_bytes() for p in (Path(source)/'connector').glob('*.py')}
    files['app/__init__.py']=b'';files['app/protocols.py']=(Path(source)/'app/protocols.py').read_bytes()
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,blob in sorted(files.items()):archive.writestr(name,blob)
    blob=out.getvalue();manifest=dict(format=1,revision=revision,protocol=4,abi=RUNTIME_ABI,expires=int(time.time())+expires_days*86400,package=f'/api/connector/client/packages/{revision}.zip',bytes=len(blob),sha256=hashlib.sha256(blob).hexdigest(),files={n:hashlib.sha256(v).hexdigest() for n,v in files.items()})
    envelope=dict(manifest=manifest,signature=key.sign(canonical(manifest)).hex())
    from client.updates import verify_manifest
    public=key.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw).hex();verify_manifest(envelope,public)
    path.parent.mkdir(exist_ok=True);path.write_bytes(blob)
    atomic_json(output/'manifests'/f'{revision}.json',envelope)
    atomic_json(output/'manifest.json',envelope)
    return dict(revision=revision,publicKey=public,bytes=len(blob),sha256=manifest['sha256'])


def renew(output,key_file,expires_days=30):
    output=Path(output);key=Ed25519PrivateKey.from_private_bytes(Path(key_file).read_bytes())
    public=key.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw).hex()
    from client.updates import verify_manifest
    envelope=json.loads((output/'manifest.json').read_text());m=verify_manifest(envelope,public,embedded=True)
    blob=(output/'packages'/f'{m["revision"]}.zip').read_bytes()
    if hashlib.sha256(blob).hexdigest()!=m['sha256'] or len(blob)!=m['bytes']:raise ValueError('原发行包已变化，不能续签')
    m['expires']=int(time.time())+expires_days*86400;envelope=dict(manifest=m,signature=key.sign(canonical(m)).hex());verify_manifest(envelope,public)
    atomic_json(output/'manifests'/f'{m["revision"]}.json',envelope);atomic_json(output/'manifest.json',envelope)
    return dict(revision=m['revision'],expires=m['expires'],codeChanged=False)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--key',type=Path,required=True);parser.add_argument('--generate-key',action='store_true');parser.add_argument('--renew-manifest',action='store_true');parser.add_argument('--output',type=Path);parser.add_argument('--revision',type=int);args=parser.parse_args()
    print(json.dumps({'publicKey':create_key(args.key)} if args.generate_key else renew(args.output,args.key) if args.renew_manifest else build(args.output,args.key,args.revision),ensure_ascii=False))

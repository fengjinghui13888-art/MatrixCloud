from __future__ import annotations
import hashlib
import json
import os
import uuid
from pathlib import Path
from typing import Any

def read_json(path: Path, default: Any = None) -> Any:
    try: return json.loads(path.read_text(encoding='utf-8-sig'))
    except FileNotFoundError: return default

def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp=path.with_name(path.name+'.'+str(uuid.uuid4())+'.tmp')
    try:
        with temp.open('x', encoding='utf8') as stream:
            os.chmod(temp,0o600)
            json.dump(value,stream,ensure_ascii=False,separators=(',',':')); stream.flush(); os.fsync(stream.fileno())
        temp.replace(path)
    finally: temp.unlink(missing_ok=True)

def canonical_json(value: Any) -> str:
    return json.dumps(value,ensure_ascii=False,separators=(',',':'))

def fingerprint(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()

def safe_file(base: Path, relative: str) -> Path:
    root=base.resolve(strict=True); path=(root/relative).resolve(strict=True)
    if not path.is_relative_to(root) or path==root or not path.is_file(): raise ValueError('媒体路径无效')
    return path

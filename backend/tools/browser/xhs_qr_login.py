"""Explicit QR browser lifecycle entrypoint, using retained account profiles."""
import argparse
import asyncio
import json
import os
from pathlib import Path
from connector.browser import BrowserRuntime

async def execute(root,id,action):
    runtime=BrowserRuntime(root)
    try:
        if action=='login':return await runtime.login(id)
        if action=='image':return await runtime.qr(id)
        return await runtime.state(id)
    finally:await runtime.close()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('account_id');parser.add_argument('action',choices=['login','state','image']);parser.add_argument('--root',default=os.environ.get('LOCAL_CONNECTOR_ROOT',str(Path.home()/'.matrix-cloud')));args=parser.parse_args()
    from app.protocols import valid_id
    if not valid_id(args.account_id):parser.error('无效会话编号')
    print(json.dumps(asyncio.run(execute(Path(args.root).resolve(),args.account_id,args.action)),ensure_ascii=False))

if __name__=='__main__':main()

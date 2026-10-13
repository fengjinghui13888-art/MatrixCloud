"""Run a connector sync input file through direct Python collection."""
import argparse
import asyncio
import json
from pathlib import Path
from connector.browser import BrowserRuntime
from connector.sync import SyncExecutor
from connector.files import read_json,atomic_json

async def execute(root,job_id):
    input=read_json(root/'sync-jobs'/job_id/'input.json')
    if not input:raise ValueError('同步输入不存在')
    runtime=BrowserRuntime(root)
    async def progress(patch):
        state=read_json(root/'sync-jobs'/job_id/'state.json',{}); atomic_json(root/'sync-jobs'/job_id/'state.json',{**state,**patch})
    try:
        result=await SyncExecutor(root,runtime)({**input,'_jobId':job_id},progress); atomic_json(root/'sync-jobs'/job_id/'result.json',result); return result
    finally:await runtime.close()

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('job_id'); parser.add_argument('--root',required=True); args=parser.parse_args()
    from app.protocols import valid_uuid
    if not valid_uuid(args.job_id):parser.error('同步编号无效')
    asyncio.run(execute(Path(args.root).resolve(),args.job_id))

if __name__=='__main__':main()

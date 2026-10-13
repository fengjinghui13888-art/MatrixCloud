"""Execute one approved draft using the same connector safety pipeline."""
import argparse
import asyncio
import json
import os
from pathlib import Path
from connector.browser import BrowserRuntime
from connector.draft import DraftExecutor

async def execute(input,root):
    runtime=BrowserRuntime(root)
    async def progress(patch):print(json.dumps(patch,ensure_ascii=False),flush=True)
    try:return await DraftExecutor(root,runtime)(input,progress)
    finally:await runtime.close()

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('task_id'); parser.add_argument('--root',default=os.environ.get('LOCAL_CONNECTOR_ROOT',str(Path.home()/'.matrix-cloud'))); args=parser.parse_args()
    input=dict(taskId=args.task_id,profile=os.environ.get('MATRIX_PROFILE',''),apiBase=os.environ.get('STUDIO_URL',''),token=os.environ.get('STUDIO_TOKEN',''),runId=os.environ.get('STUDIO_RUN_ID',''),startedAt=os.environ.get('STUDIO_STARTED_AT',''))
    from app.protocols import valid_profile,valid_uuid
    if not valid_profile(input['profile']) or not valid_uuid(input['taskId']) or not valid_uuid(input['runId']) or not input['token']:parser.error('需要工作区凭证、绑定 profile、runId 和 taskId')
    asyncio.run(execute(input,Path(args.root).resolve()))

if __name__=='__main__':main()

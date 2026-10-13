"""CLI is independent of CWD and forwards repeat launches to a verified connector."""
from __future__ import annotations
import argparse
import asyncio
import os
from pathlib import Path
import httpx
import uvicorn
from .server import create_connector_app
from .cloud import normalize_cloud_url

async def inspect_existing_connector(port):
    try:
        async with httpx.AsyncClient(follow_redirects=False,timeout=2,trust_env=False) as client:
            response=await client.get(f'http://127.0.0.1:{port}/health'); value=response.json()
            if response.status_code!=200 or value.get('connector')!='matrix-cloud-local':return dict(kind='foreign')
            if value.get('version',0)<4 or not {'reconnect','stop-ack','device-queue'}.issubset(value.get('capabilities',[])):return dict(kind='outdated',value=value)
            return dict(kind='connected',value=value)
    except httpx.ConnectError:return dict(kind='absent')
    except (httpx.HTTPError,ValueError):return dict(kind='foreign')

async def serve(args):
    root=Path(args.data_dir).expanduser().resolve(); status=await inspect_existing_connector(args.port)
    if status['kind']=='connected':
        token_path=root/'connector-token'
        if not token_path.is_file():raise ValueError('连接器已经运行，但此数据目录不拥有本机凭证')
        async with httpx.AsyncClient(follow_redirects=False,timeout=20,trust_env=False) as client:
            response=await client.post(f'http://127.0.0.1:{args.port}/reconnect',headers={'Authorization':'Bearer '+token_path.read_text().strip()},json=dict(cloudUrl=args.cloud_url,pairingCode=args.pairing_code,deviceName=args.device_name,onboard=args.onboard))
            value=response.json(); print(value.get('message','已转交给正在运行的连接器。'))
            if response.status_code not in (200,409):raise ValueError('未能转交本次配对操作')
        return
    if status['kind']!='absent':raise ValueError('该端口已被其他服务或旧连接器占用，请关闭旧连接器后重试')
    app=create_connector_app(root,args.cloud_url,args.port); runtime=app.state.connector
    if args.pairing_code:
        if not args.cloud_url:raise ValueError('配对需要工作台地址')
        # Persist before ASGI startup; cloud connects once from the lifespan.
        from .cloud import register_cloud_connector
        await register_cloud_connector(cloud_url=args.cloud_url,pairing_code=args.pairing_code,root=root,device_name=args.device_name or None)
    if args.onboard:
        from .cloud import load_cloud_device
        device=load_cloud_device(root)
        target=args.cloud_url or (device or {}).get('cloudUrl','')
        if not target:raise ValueError('授权连接需要工作台地址')
        url=runtime.begin_onboarding(target) if not device or normalize_cloud_url(device['cloudUrl'])!=normalize_cloud_url(target) else target
        print('请在工作台授权连接：'+url)
        import webbrowser
        webbrowser.open(url,new=2)
    print(f'矩阵云本机连接器 v4 已启动：http://127.0.0.1:{args.port}')
    await uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=args.port,log_level='info',access_log=False)).serve()

def main(argv=None):
    parser=argparse.ArgumentParser(description='矩阵云 Python 本机连接器 v4')
    parser.add_argument('--data-dir',default=os.environ.get('LOCAL_CONNECTOR_ROOT',str(Path.home()/'.matrix-cloud')))
    parser.add_argument('--port',type=int,default=47821)
    parser.add_argument('--cloud-url',default=os.environ.get('MATRIX_CLOUD_URL',''))
    parser.add_argument('--pairing-code',default=os.environ.get('MATRIX_CLOUD_PAIRING_CODE',''))
    parser.add_argument('--device-name',default=os.environ.get('MATRIX_CLOUD_DEVICE_NAME',''))
    parser.add_argument('--onboard',action='store_true')
    parser.add_argument('--pair',action='store_true',help='交互输入工作台生成的 8 位配对码')
    args=parser.parse_args(argv)
    if args.pair and not args.pairing_code:
        try:
            args.pairing_code=input('请输入工作台生成的 8 位配对码：').strip()
            if not args.device_name:args.device_name=input('这台电脑名称（可直接回车）：').strip()
        except (EOFError,KeyboardInterrupt):print('配对已取消'); return 1
    if not 1<=args.port<=65535:parser.error('port must be between 1 and 65535')
    try:asyncio.run(serve(args))
    except (ValueError,OSError) as exc:print(str(exc)); return 1
    return 0

if __name__=='__main__':raise SystemExit(main())

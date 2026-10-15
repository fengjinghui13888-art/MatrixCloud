"""Explicit local provisioning of the one platform owner, separate from customers."""
import argparse
from dataclasses import replace
import json
import os
from pathlib import Path
import secrets
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.settings import Settings,load_env_file
from app.services import Services

def main():
    p=argparse.ArgumentParser(description='在服务器本机初始化独立平台管理员，不修改现有客户')
    p.add_argument('--username',default='matrix-admin');p.add_argument('--output',type=Path,required=True)
    args=p.parse_args();load_env_file();settings=Settings.from_env()
    if settings.platform_admin_username and settings.platform_admin_username!=args.username:p.error('平台已配置管理员，请使用现有账号或恢复密码')
    settings=replace(settings,platform_admin_username=args.username)
    services=Services(settings);marker=settings.data_dir/'platform-owner'
    with services.auth.transaction() as c:
        if any(u['workspace']=='owner' for u in services.auth._users(c)):p.error('平台管理员已存在，请使用恢复密码流程，不能重复初始化')
    password=secrets.token_urlsafe(24)
    fd=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w',encoding='utf8') as f:
        result=services.auth.setup(dict(username=args.username,password=password),ip='local-platform-provisioning',local=True)
        services.auth.logout('zhixu_session='+result['token'])
        json.dump(dict(username=args.username,password=password,url=settings.public_origin.rstrip('/')+'/admin.html'),f,ensure_ascii=False,indent=2)
    if not marker.exists():
        with marker.open('x',encoding='utf8') as f:f.write(args.username)
    services.close();print('平台管理员已初始化，登录信息只写入指定私有文件。重启后端后生效。')

if __name__=='__main__':main()

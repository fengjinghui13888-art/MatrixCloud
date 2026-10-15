"""Run on the server as its administrator; never expose this issuer publicly."""
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.settings import Settings,load_env_file
from app.services import Services
from app.recovery import issue_recovery

def main():
    parser=argparse.ArgumentParser(description='核实账号归属后签发一次性密码恢复码，有效期15分钟')
    parser.add_argument('--username',required=True)
    parser.add_argument('--output',type=Path,help='只写入指定的新文件，不在控制台显示恢复码')
    args=parser.parse_args()
    if args.output and args.output.exists():parser.error('输出文件已存在，请指定新文件，原恢复码不会被覆盖')
    load_env_file();services=Services(Settings.from_env())
    try:
        result=issue_recovery(services.auth,args.username)
        if args.output:
            with args.output.open('x',encoding='utf8') as f:json.dump(result,f,ensure_ascii=False,indent=2)
            print('恢复码已保存至指定文件，有效期15分钟。请勿发送给无关人员。')
        else:print(json.dumps(result,ensure_ascii=False))
    finally:services.close()

if __name__=='__main__':main()

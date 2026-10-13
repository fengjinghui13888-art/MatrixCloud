#!/usr/bin/env python3
"""Start a persistent supervisor under the current user's file permissions."""
import os,sys,subprocess,pathlib,time,urllib.request
root=pathlib.Path(__file__).resolve().parent.parent
node=pathlib.Path(sys.argv[1]).resolve()
try:
 with urllib.request.urlopen('http://127.0.0.1:4174/api/health',timeout=2) as response:
  if response.status==200:print('工作台已运行：http://127.0.0.1:4174/');sys.exit(0)
except OSError:pass
if os.name == 'nt':
 flags = getattr(subprocess, 'DETACHED_PROCESS', 0x00000008) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0x00000200)
 process=subprocess.Popen([str(node),'scripts/local-supervisor.mjs'],cwd=root,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=flags)
else:
 process=subprocess.Popen([str(node),'scripts/local-supervisor.mjs'],cwd=root,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
for _ in range(80):
 try:
  with urllib.request.urlopen('http://127.0.0.1:4174/api/health',timeout=1) as response:
   if response.status==200:print('守护进程已启动：http://127.0.0.1:4174/');sys.exit(0)
 except OSError:time.sleep(.25)
print('启动失败，请检查 work/service-logs/workbench-error.log');sys.exit(1)

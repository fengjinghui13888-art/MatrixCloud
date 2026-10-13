"""Run with Python 3.10+ to install the project's private media downloader."""
import pathlib,subprocess,sys,venv
root=pathlib.Path(__file__).resolve().parent.parent
folder=root/'work'/'collector-venv'
venv.EnvBuilder(with_pip=True).create(folder)
python=folder/('Scripts/python.exe' if sys.platform=='win32' else 'bin/python')
subprocess.run([str(python),'-m','pip','install','-r',str(root/'scripts'/'collector-requirements.txt')],check=True)
print('媒体下载环境已安装；请另运行 pnpm install 安装 Playwright 连接库，无需下载新浏览器。')

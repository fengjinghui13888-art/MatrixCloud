"""Locate the browser shipped with the client; never install during login."""
from pathlib import Path
import os
import sys


def bundled_browser_roots():
    roots=[]
    if getattr(sys,'frozen',False) and getattr(sys,'_MEIPASS',None):
        roots.append(Path(sys._MEIPASS)/'browsers')
    # Explicit development/managed deployment paths only. Customer packages use
    # their embedded runtime and do not depend on a user's Playwright cache.
    for name in ('MATRIX_BROWSER_ROOT','PLAYWRIGHT_BROWSERS_PATH'):
        if os.getenv(name) and os.environ[name]!='0':roots.append(Path(os.environ[name]))
    return roots


def packaged_browser(root,platform_name=None):
    root=Path(root).resolve();platform_name=platform_name or sys.platform
    if platform_name=='win32':patterns=['chromium-*/chrome-win64/chrome.exe','chromium-*/chrome-win/chrome.exe']
    elif platform_name=='darwin':patterns=['chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium','chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']
    else:patterns=['chromium-*/chrome-linux64/chrome','chromium-*/chrome-linux/chrome']
    for pattern in patterns:
        for path in sorted(root.glob(pattern),reverse=True):
            if path.is_file() and path.resolve().is_relative_to(root):return str(path)
    return None

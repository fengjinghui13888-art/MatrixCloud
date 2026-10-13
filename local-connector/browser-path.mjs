import {existsSync} from 'node:fs';
import {join} from 'node:path';

export function chromeCandidates({platform=process.platform,env=process.env,home=env.HOME||env.USERPROFILE||''}={}){
  const candidates=[env.CHROME_BIN];
  if(platform==='win32'){
    for(const base of [env.LOCALAPPDATA,env.ProgramFiles,env['PROGRAMFILES'],env['ProgramFiles(x86)'],env['PROGRAMFILES(X86)']]){
      if(base)candidates.push(join(base,'Google','Chrome','Application','chrome.exe'));
    }
  }else if(platform==='darwin'){
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    if(home)candidates.push(join(home,'Applications','Google Chrome.app','Contents','MacOS','Google Chrome'));
  }else{
    candidates.push('/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser');
  }
  // Use the installed Chromium-based Edge when Chrome is absent (common on Windows).
  if(platform==='win32'){
    for(const base of [env.LOCALAPPDATA,env.ProgramFiles,env['ProgramFiles(x86)'],env['PROGRAMFILES(X86)']])
      if(base)candidates.push(join(base,'Microsoft','Edge','Application','msedge.exe'));
  }else if(platform==='darwin'){
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    if(home)candidates.push(join(home,'Applications','Microsoft Edge.app','Contents','MacOS','Microsoft Edge'));
  }else{
    candidates.push('/usr/bin/microsoft-edge','/usr/bin/microsoft-edge-stable');
  }
  return [...new Set(candidates.filter(Boolean))];
}

export function findChrome(options={},exists=existsSync){
  const candidates=chromeCandidates(options);
  const found=candidates.find(path=>exists(path));
  if(found)return found;
  throw Error('未找到 Google Chrome 或 Microsoft Edge。请安装其中一个浏览器后重新打开连接器。');
}

import {connectLocalBrowser} from './local-browser.mjs';
import {pathToFileURL} from 'node:url';
import {evaluateScript} from './studio-transfer.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
export async function connectStudioBrowser({cli,profile,session='studio-executor'}) {
 if(profile?.startsWith('local:'))return connectLocalBrowser(profile);
 const root=new URL('./browser/',pathToFileURL(cli));
 const [{BrowserBridge},{setDaemonCommandTimeoutSeconds}]=await Promise.all([import(new URL('bridge.js',root)),import(new URL('daemon-client.js',root))]);
 setDaemonCommandTimeoutSeconds(25);const bridge=new BrowserBridge();
 const page=await bridge.connect({session,contextId:profile,windowMode:'foreground'});
 // Four validated 12 KB chunks per request; original assembly/event semantics.
 return {page,evaluate:source=>evaluateScript(js=>page.evaluate(js),source,{batchSize:4}),close:()=>bridge.close(),
  foreground:()=>focusExistingCreator(page),
  activate:()=>focusPage(page)
 };
}
const selectExistingTab=`on run argv
 set wantedURL to item 1 of argv
 tell application "Google Chrome"
  set foundCount to 0
  repeat with browserWindow in windows
   set tabNumber to 0
   repeat with browserTab in tabs of browserWindow
    set tabNumber to tabNumber + 1
    if URL of browserTab is wantedURL then
     set foundCount to foundCount + 1
     set matchedWindow to browserWindow
     set matchedIndex to tabNumber
    end if
   end repeat
  end repeat
  if foundCount is not 1 then error "Expected exactly one existing creator tab"
  set active tab index of matchedWindow to matchedIndex
  set minimized of matchedWindow to false
  set index of matchedWindow to 1
  activate
 end tell
end run`;

export async function focusExistingCreator(page,{platform=process.platform,run=promisify(execFile)}={}) {
 // Read the extension's tab inventory, not a possibly suspended renderer.
 // The first page evaluation must happen after activation.
 const current=(await page.tabs()).find(tab=>tab.page===page.getActivePage());
 const url=current?.url;
 if(!url)throw Error('未找到当前绑定的图文创作页');
 const parsed=new URL(url);
 if(parsed.origin!=='https://creator.xiaohongshu.com'||parsed.pathname!=='/publish/publish'||parsed.searchParams.get('target')!=='image')throw Error('当前绑定页面不是小红书图文创作页');
 // OpenCLI 1.8.6 selectTab binds commands but does not activate the Chrome tab;
 // its extension also rejects Page.bringToFront. Select an existing tab via the
 // macOS app interface, passing the URL as data. Never open/navigate a new page.
 await focusPage(page,{platform,run});
}
export async function focusPage(page,{platform=process.platform,run=promisify(execFile)}={}) {
 const current=(await page.tabs()).find(tab=>tab.page===page.getActivePage());
 const url=current?.url;
 if(!url)throw Error('未找到当前浏览器页面');
 if(platform==='darwin')await run('/usr/bin/osascript',['-e',selectExistingTab,url],{timeout:5000});
 else if(platform==='win32')await focusWindowsTab(url,{run});
 else await page.cdp('Page.bringToFront');
}
export async function focusWindowsTab(url,{run=promisify(execFile)}={}) {
 const script=`$sh=New-Object -ComObject WScript.Shell; if(-not (Get-Process chrome -ErrorAction SilentlyContinue)){throw '未找到 Chrome 窗口'}; $sh.AppActivate('Google Chrome') | Out-Null`;
 await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{timeout:5000});
}
export const IMAGE_INPUT_SELECTOR='input[type="file"][multiple][accept*=".jpg"]';
export async function uploadLocalFiles(page,files,selector=IMAGE_INPUT_SELECTOR) {
 await page.cdp('DOM.enable');const {root}=await page.cdp('DOM.getDocument',{depth:0});
 const {nodeIds}=await page.cdp('DOM.querySelectorAll',{nodeId:root.nodeId,selector});
 if(nodeIds?.length!==1)throw Error(`图片上传控件数量异常：要求 1，实际 ${nodeIds?.length??0}`);
 // Do not call the separate chooser-based action on rejection: on the installed
 // extension it times out despite the valid input. The caller decides fallback
 // only after checking the actual editor for partial uploads.
 await page.cdp('DOM.setFileInputFiles',{files,nodeId:nodeIds[0]});
 return {uploaded:true,files:files.length};
}

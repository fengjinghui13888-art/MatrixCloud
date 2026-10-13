import {readFile, writeFile} from 'node:fs/promises';
import {connectStudioBrowser} from './studio-browser.mjs';
import {browserBridgePath} from './browser-bridge-path.mjs';
const statePath=process.env.QR_STATE_PATH,imagePath=process.env.QR_IMAGE_PATH,id=process.argv[2],profile=process.env.QR_PROFILE;
const cli=browserBridgePath();
const save=async(p)=>{const old=JSON.parse(await readFile(statePath,'utf8'));await writeFile(statePath,JSON.stringify({...old,...p}),{mode:0o600});};
let connection;
try{
  connection=await connectStudioBrowser({cli,profile,session:`xhs-qr-${id}`});
  const {page}=connection;const tabs=await page.tabs();
  // Always start from the creator service platform. The consumer site login
  // page does not establish the creator console session needed by the matrix.
  const login=tabs.find(t=>/^https:\/\/creator\.xiaohongshu\.com\/login/i.test(String(t.url||'')))?.page??await page.newTab('https://creator.xiaohongshu.com/login');
  await page.selectTab(login);await connection.activate();
  const existing=await page.evaluate(`(()=>{const text=document.body?.innerText||'';const line=text.split('\\n').map(x=>x.trim()).find(x=>x.includes('小红书账号'));const handle=line?line.replace(/^.*小红书账号[:：]?/,'').trim():'';const name=(document.querySelector('.account-name, .user-info .name-box')?.textContent||'').trim();return {url:location.href,text,handle,name}})()`);
  if(/^https:\/\/creator\.xiaohongshu\.com\/(new\/home|home)/i.test(existing.url)&&existing.handle){
    await save({status:'authenticated',message:'检测到已登录的创作服务平台账号，正在写入账号矩阵…',detectedName:existing.name,detectedHandle:existing.handle});
    process.exit(0);
  }
  const qrDeadline=Date.now()+15000;let qrReady=false;
  while(Date.now()<qrDeadline){
    const ready=await page.evaluate(`!!document.querySelector('img[src*="qr" i],canvas,[class*="qr" i]')`);
    if(ready){qrReady=true;break;}
    await new Promise(r=>setTimeout(r,300));
  }
  if(!qrReady)throw Error('创作服务平台登录页未显示二维码，请刷新后重试');
  await page.screenshot({path:imagePath});await save({status:'waiting_scan',message:'请使用小红书 App 扫描创作服务平台二维码；扫码过程在当前 Chrome 中可见'});
  const deadline=Date.now()+5*60*1000;let authenticated=false;
  while(Date.now()<deadline){
    const info=await page.evaluate(`(()=>{const text=(document.body?.innerText||'').slice(0,6000);const accountLine=text.split('\\n').map(x=>x.trim()).find(x=>x.includes('小红书账号'));const handle=accountLine?accountLine.replace(/^.*小红书账号[:：]?/,'').trim():'';const name=(document.querySelector('.account-name, .user-info .name-box, #header-area, .header-area')?.textContent||'').trim().split('\\n').map(x=>x.trim()).find(x=>x&&x.length<80&&!/登录|扫码|创作服务平台/i.test(x))||'';return {url:location.href,text,handle,name,login:!!document.querySelector('img[src*="qr"],canvas,[class*="qr" i]')}})()`);
    await page.screenshot({path:imagePath});
    const logged=/^https:\/\/creator\.xiaohongshu\.com\//i.test(info.url) && !/\/login|登录|扫码登录|手机号登录/i.test(info.url+' '+info.text) && /创作|发布|数据|首页|内容/i.test(info.text);
    if(logged){authenticated=true;const fallbackName=info.name||info.text.match(/\b[A-Za-z][A-Za-z0-9_.-]{2,39}\b/)?.[0]||'';await save({status:'authenticated',message:'扫码成功，正在读取账号资料…',detected:fallbackName,detectedName:fallbackName,detectedHandle:info.handle});break;}
    await new Promise(r=>setTimeout(r,1000));
  }
  if(!authenticated)throw Error('二维码登录等待超时，请重新发起扫码');
}catch(e){await save({status:'failed',message:e instanceof Error?e.message:'二维码登录失败'});process.exitCode=1;}finally{await connection?.close().catch(()=>{});}

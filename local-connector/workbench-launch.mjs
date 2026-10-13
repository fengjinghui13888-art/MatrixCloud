import {spawn} from 'node:child_process';
import {normalizeCloudUrl} from './cloud-client.mjs';

export function openWorkbench(url,{platform=process.platform,spawnFn=spawn,onError=()=>console.error('工作台未能自动打开，请复制窗口中的授权地址到浏览器。')}={}){
 const target=new URL(url);
 normalizeCloudUrl(target.origin);
 if(target.pathname!=='/'||target.search||(target.hash&&!/^#connectorSetup=[a-f0-9]{64}$/.test(target.hash)))throw Error('工作台地址无效');
 const command=platform==='darwin'?'open':platform==='win32'?'rundll32':'xdg-open';
 const child=spawnFn(command,platform==='win32'?['url.dll,FileProtocolHandler',target.href]:[target.href],{stdio:'ignore',shell:false});
 child.once('error',onError);
 return child;
}

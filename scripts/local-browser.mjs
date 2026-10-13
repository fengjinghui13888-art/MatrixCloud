import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {projectPath} from './runtime-path.mjs';
import {connectPage} from '../local-connector/cdp.mjs';
export async function connectLocalBrowser(profile){
 const id=profile.slice(6);if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw Error('无效本机会话');
 const root=process.env.LOCAL_CONNECTOR_ROOT||projectPath('work','grey','local-connector');
 const token=process.env.LOCAL_CONNECTOR_TOKEN?.trim()||(await readFile(join(root,'connector-token'),'utf8')).trim();
 const connector=process.env.LOCAL_CONNECTOR_URL||`http://127.0.0.1:${process.env.LOCAL_CONNECTOR_PORT||47821}`; const r=await fetch(`${connector.replace(/\/$/,'')}/accounts/${id}/connect`,{method:'POST',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});
 const value=await r.json();if(!r.ok)throw Error(value.message||'本机连接器不可用');
 return connectPage(value.debugPort);
}

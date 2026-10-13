import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export function executionGuard(root,profile,{now=Date.now}={}){
 const dir=join(root,'account-safety');mkdirSync(dir,{recursive:true,mode:0o700});const file=join(dir,createHash('sha256').update(profile).digest('hex')+'.json');
 const check=()=>{const lease=join(root,'device-lease.json');if(existsSync(lease)&&(JSON.parse(readFileSync(lease,'utf8')).until<now()||(process.env.MATRIX_DEVICE_EPOCH&&JSON.parse(readFileSync(lease,'utf8')).epoch!==process.env.MATRIX_DEVICE_EPOCH)))throw Error('执行器连接租约已失效，已停止后续操作');if(existsSync(file)){const s=JSON.parse(readFileSync(file,'utf8'));if(s.state!=='normal')throw Error('账号已暂停自动操作，请人工核对平台提示后恢复');}};
 return {check,status:()=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{state:'normal'},halt(reason,retryAfter){const until=typeof retryAfter==='string'&&/^\d+$/.test(retryAfter)?now()+Number(retryAfter)*1000:Date.parse(retryAfter??'');writeFileSync(file,JSON.stringify({state:Number.isFinite(until)?'cooldown':'paused',until:Number.isFinite(until)?until:null,reason:String(reason).slice(0,300),at:now()}),{mode:0o600});},resume(confirmed){if(confirmed!==true)throw Error('需要人工核对');if(existsSync(file)){const s=JSON.parse(readFileSync(file,'utf8'));if(s.until&&s.until>now())throw Error('平台等待时间尚未结束');}writeFileSync(file,JSON.stringify({state:'normal',at:now()}),{mode:0o600});}};
}

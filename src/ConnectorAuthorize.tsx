import {useRef,useState} from 'react';
import {customerMessage} from './customer-message';
import {writeSessionValue} from './safe-storage';

export function ConnectorAuthorize({nonce,request}:{nonce:string;request:(path:string,body?:unknown)=>Promise<any>}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');const active=useRef(false);
 async function authorize(){
  if(active.current)return;active.current=true;setBusy(true);setError('');
  try{
   const pairing=await request('connector/pairings',{});
   // Returning from the loopback page resumes this exact pairing in the same tab.
    // This is only a resume hint.  Safari private/managed profiles may reject
    // sessionStorage; authorization still completes through the local form.
    writeSessionValue('matrix.pendingPairing',JSON.stringify({id:pairing.id,status:'pending',expiresAt:pairing.expiresAt}));
   // Use a top-level loopback navigation instead of an HTTPS -> HTTP form
   // POST. Safari and managed Edge profiles may block that mixed-content form
   // while still allowing an explicit user-triggered navigation. The local
   // connector validates the nonce and one-use pairing code before registering.
   const target=new URL('http://127.0.0.1:47821/onboarding');target.searchParams.set('nonce',nonce);target.searchParams.set('code',String(pairing.code));
   const link=document.createElement('a');link.href=target.href;link.hidden=true;document.body.append(link);link.click();link.remove();
  }catch(e){setError(customerMessage(e,'电脑连接未完成，请重试'));}
  finally{active.current=false;setBusy(false);}
 }
 return <section className="grey-panel" aria-label="授权本机连接"><h2>将这台电脑连接到当前团队</h2><p>授权后，这台电脑可接收你在工作台发起的登录、同步和草稿任务。请确认上方登录的是你的团队账号。</p><button className="primary" disabled={busy} onClick={()=>void authorize()}>{busy?'正在连接…':'授权连接这台电脑'}</button>{error&&<p role="alert">{error}</p>}</section>;
}

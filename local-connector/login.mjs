import {readIdentity} from './identity.mjs';

export async function prepareLogin(connection){
  await connection.activate();
  const end=Date.now()+25000;
  let switched=false;
  while(Date.now()<end){
    const state=await connection.evaluate(`(()=>({
      identity:(${readIdentity.toString()})(),
      text:document.body?.innerText||'',
      toggle:(()=>{
        const e=document.querySelector('img.css-wemwzq,img[class*="wemwzq" i]');
        if(!e)return null;
        const r=e.getBoundingClientRect();
        return r.width>20&&r.height>20?{x:r.x+r.width/2,y:r.y+r.height/2}:null;
      })(),
      qr:[...document.querySelectorAll('img.css-1lhmg90,img[src*="qr" i],canvas,[class*="qr" i]')].some(e=>{
        const r=e.getBoundingClientRect();
        return r.width>100&&r.height>100&&r.bottom>0&&r.right>0;
      })
    }))()`);
    if(state.identity.loggedIn)return;
    if(state.qr)return;
    if(!switched&&state.toggle&&/短信登录|手机号|登录/.test(state.text)){
      await connection.evaluate(`(()=>{const e=document.querySelector('img.css-wemwzq,img[class*="wemwzq" i]');if(e)e.click();})()`);
      switched=true;
    }
    await new Promise(r=>setTimeout(r,200));
  }
  throw Error('创作平台二维码未就绪，请检查可见 Chrome 登录窗口');
}

export async function captureQr(connection){
  const clip=await connection.evaluate(`(()=>{
    const selectors=['img.css-1lhmg90','img[src*="qr" i]','canvas','[class*="qr" i]'];
    for(const selector of selectors){
      for(const e of document.querySelectorAll(selector)){
        const r=e.getBoundingClientRect();
        if(r.width>100&&r.height>100&&r.bottom>0&&r.right>0){
          return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};
        }
      }
    }
    return null;
  })()`);
  if(!clip)throw Error('当前页面没有可用二维码');
  return connection.page.cdp('Page.captureScreenshot',{format:'png',clip});
}

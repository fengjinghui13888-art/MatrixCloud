// Fail closed on visible verification/restriction messages and platform HTTP limits.
export async function protectStudioConnection(connection,guard,pace){
 const page=connection.page,rawEvaluate=connection.evaluate,rawCdp=page.cdp.bind(page);
 let halted;
 const halt=(reason,retryAfter)=>{if(!halted){halted=Error(reason);guard.halt(reason,retryAfter);}};
 const check=async()=>{guard.check();if(halted)throw halted;const text=await rawEvaluate('document.body?.innerText?.slice(0,30000)||""');if(/安全验证|请完成验证|访问过于频繁|账号已被限制|账号异常|异常登录|账号被封禁|操作频繁|滑动验证/.test(text)){halt('平台要求验证或限制了操作，请在原电脑人工核对');throw halted;}guard.check();};
 await page.onEvent?.(event=>{if(event.method!=='Network.responseReceived')return;const r=event.params?.response;try{if(new URL(r.url).hostname.endsWith('.xiaohongshu.com')&&[401,403,429].includes(r.status))halt('平台登录异常或请求受限，已暂停后续操作',Object.entries(r.headers??{}).find(([k])=>k.toLowerCase()==='retry-after')?.[1]);}catch{}});
 page.cdp=async(method,args)=>{guard.check();if(halted)throw halted;if(/^(Input\.|DOM.setFileInputFiles|Page.navigate)/.test(method))await check();return rawCdp(method,args);};
 connection.evaluate=async source=>{await check();return rawEvaluate(source);};page.evaluate=connection.evaluate;
 for(const method of ['nativeClick','insertText']){const original=page[method]?.bind(page);if(original)page[method]=async(...args)=>{await check();return original(...args);};}
 for(const method of ['goto','newTab']){const original=page[method]?.bind(page);if(original)page[method]=async(...args)=>{await check();await pace();guard.check();if(halted)throw halted;return original(...args);};}
 const select=page.selectTab.bind(page);page.selectTab=async(...args)=>{await select(...args);await rawCdp('Network.enable');};
 await rawCdp('Network.enable');return check;
}

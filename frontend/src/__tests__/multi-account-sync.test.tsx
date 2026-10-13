import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {GreyApp} from '../GreyApp';

const accounts=['JINGHUI','FJINGHUI'].map((name,index)=>({id:index?'f':'j',name,handle:name,profile:'local:'+name,avatar:'',state:'connected',followers:0,lastSyncedAt:'',executionDevice:{id:'d',name:'测试电脑',online:true}}));
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
type Route=(path:string,options?:RequestInit)=>Response|Promise<Response>|undefined;

function fixture(route:Route){
 const fetcher=vi.fn(async(url:RequestInfo|URL,options?:RequestInit)=>{
  const path=String(url),override=route(path,options);if(override!==undefined)return override;
  if(path==='/api/auth/status')return response({configured:true});
  if(path==='/api/auth/session')return response({username:'fixture'});
  if(path==='/api/operations')return response({accounts,notes:[],comments:[],leads:[]});
  if(path==='/api/accounts')return response(accounts);
  if(path==='/api/connector/devices')return response({selectedDeviceId:'d',devices:[{id:'d',name:'测试电脑',platform:'win32',version:'4.0.0',online:true,executionReady:true,revoked:false}]});
  if(path==='/api/connector/capabilities')return response({secure:true});
  return response(null);
 });
 vi.stubGlobal('fetch',fetcher);vi.spyOn(window,'confirm').mockReturnValue(true);return fetcher;
}
async function openAccounts(){render(<GreyApp/>);await screen.findByText('已同步账号');fireEvent.click(screen.getByRole('button',{name:'账号矩阵'}));await screen.findByRole('heading',{name:'JINGHUI',level:3});}
const card=(name:string)=>within(screen.getByRole('heading',{name,level:3}).closest('section')!);
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

test('binds a second-account submission failure to that account while preserving the first result',async()=>{
 fixture(path=>path==='/api/accounts/j/sync'?response({id:'job-j',accountId:'j',status:'complete',counts:{notes:2}}):path==='/api/accounts/f/sync'?response({message:'执行电脑拒绝本次同步请求'},409):undefined);
 await openAccounts();fireEvent.click(screen.getByRole('button',{name:'同步全部账号'}));
 await waitFor(()=>expect(card('JINGHUI').getByRole('status')).toHaveTextContent('同步完成'));
 expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('执行电脑拒绝本次同步请求');
 expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('未确认');
});

test('shows which remaining account was paused after the first submission fails',async()=>{
 const fetcher=fixture(path=>path==='/api/accounts/j/sync'?response({message:'执行电脑暂不可用'},503):undefined);
 await openAccounts();fireEvent.click(screen.getByRole('button',{name:'同步全部账号'}));
 await waitFor(()=>expect(card('JINGHUI').getByRole('status')).toHaveTextContent('执行电脑暂不可用'));
 expect(card('FJINGHUI').getByRole('status')).toHaveTextContent(/JINGHUI.*暂停/);
 expect(fetcher.mock.calls.filter(([url,options])=>String(url)==='/api/accounts/f/sync'&&options?.method==='POST')).toHaveLength(0);
});

test('shows each pending submission and ends a hung request without claiming the server failed',async()=>{
 const fetcher=fixture((path,options)=>path==='/api/accounts/j/sync'?new Promise<Response>((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})):undefined);
 await openAccounts();vi.useFakeTimers();fireEvent.click(screen.getByRole('button',{name:'同步全部账号'}));await act(async()=>{});
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent(/提交.*确认/);
 expect(card('FJINGHUI').getByRole('status')).toHaveTextContent(/等待/);
 expect(screen.queryByRole('button',{name:'停止'})).not.toBeInTheDocument();
 await act(async()=>{await vi.advanceTimersByTimeAsync(66000);});
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent(/超时.*未确认/);
 expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('暂停');
 expect(screen.getByRole('button',{name:'同步全部账号'})).toBeEnabled();
 expect(fetcher.mock.calls.filter(([url,options])=>String(url)==='/api/accounts/j/sync'&&options?.method==='POST')).toHaveLength(1);
 expect(fetcher.mock.calls.some(([url])=>String(url).includes('local-sync')||String(url).endsWith('/cancel'))).toBe(false);
});

test('keeps a successful account update when another account status request fails and clears only the recovered read error',async()=>{
 let recover=false;
 fixture(path=>{
  if(path.endsWith('/sync/latest')){const accountId=path.includes('/j/')?'j':'f';return response({id:'job-'+accountId,accountId,status:'running',stage:'notes',message:'正在读取账号内容',counts:{notes:0}});}
  if(path==='/api/accounts/j/sync/job-j')return response({id:'job-j',accountId:'j',status:'complete',counts:{notes:2}});
  if(path==='/api/accounts/f/sync/job-f')return recover?response({id:'job-f',accountId:'f',status:'complete',counts:{notes:3}}):response({message:'状态读取暂不可用'},503);
 });
 await openAccounts();
 await waitFor(()=>expect(card('JINGHUI').getByRole('status')).toHaveTextContent('同步完成'));
 expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('状态读取中断');
 expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('正在读取账号内容');
 expect(card('FJINGHUI').queryByText('同步失败')).not.toBeInTheDocument();
 recover=true;
 await waitFor(()=>expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('同步完成'),{timeout:2500});
 expect(card('FJINGHUI').getByRole('status')).not.toHaveTextContent('状态读取中断');
});

test('updates a completed account while the other status response is still pending',async()=>{
 fixture((path,options)=>{
  if(path.endsWith('/sync/latest')){const accountId=path.includes('/j/')?'j':'f';return response({id:'job-'+accountId,accountId,status:'running',stage:'notes',counts:{notes:0}});}
  if(path==='/api/accounts/j/sync/job-j')return response({id:'job-j',accountId:'j',status:'complete',counts:{notes:2}});
  if(path==='/api/accounts/f/sync/job-f')return new Promise<Response>((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
 });
 await openAccounts();await waitFor(()=>expect(card('JINGHUI').getByRole('status')).toHaveTextContent('同步完成'));
 expect(card('FJINGHUI').getByRole('status')).not.toHaveTextContent('同步完成');
});

test('continues healthy running progress while another account status and operations refresh hang',async()=>{
 let polls=0,operationReads=0;
 const pending=(options?:RequestInit)=>new Promise<Response>((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
 fixture((path,options)=>{
  if(path==='/api/operations'&&++operationReads>1)return pending(options);
  if(path.endsWith('/sync/latest')){const accountId=path.includes('/j/')?'j':'f';return response({id:'job-'+accountId,accountId,status:'running',stage:'notes',counts:{notes:0}});}
  if(path==='/api/accounts/j/sync/job-j')return response({id:'job-j',accountId:'j',status:'running',stage:'notes',message:'正在读取账号内容',counts:{notes:++polls}});
  if(path==='/api/accounts/f/sync/job-f')return pending(options);
 });
 vi.useFakeTimers();render(<GreyApp/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'账号矩阵'}));await act(async()=>{});
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('内容 1');
 await act(async()=>{await vi.advanceTimersByTimeAsync(3500);});
 expect(polls).toBeGreaterThanOrEqual(3);
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent(`内容 ${polls}`);
 expect(card('FJINGHUI').getByRole('status')).not.toHaveTextContent('同步完成');
 expect(operationReads).toBe(2);
});

test('keeps checking an unconfirmed stop when an older terminal poll must be ignored',async()=>{
 let polls=0,finishPoll:((value:Response)=>void)|undefined,finishStop:((value:Response)=>void)|undefined;
 fixture(path=>{
  if(path==='/api/accounts/j/sync/latest')return response({id:'job-j',accountId:'j',status:'running',stage:'notes'});
  if(path==='/api/accounts/j/sync/job-j')return ++polls===1?new Promise<Response>(resolve=>{finishPoll=resolve;}):response({id:'job-j',accountId:'j',status:'blocked',stopConfirmed:true,message:'停止已确认'});
  if(path==='/api/accounts/j/sync/job-j/cancel')return new Promise<Response>(resolve=>{finishStop=resolve;});
 });
 vi.useFakeTimers();render(<GreyApp/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'账号矩阵'}));await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'停止'}));await act(async()=>{});
 await act(async()=>finishPoll?.(response({id:'job-j',accountId:'j',status:'complete',counts:{notes:2}})));
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('正在停止');
 await act(async()=>finishStop?.(response({message:'停止请求结果未确认'},503)));
 await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('停止已确认');
 expect(polls).toBe(2);
});

test('aborts superseded polling so a remaining account has only one in-flight state read',async()=>{
 let activeReads=0,maxReads=0;
 fixture((path,options)=>{
  if(path.endsWith('/sync/latest')){const accountId=path.includes('/j/')?'j':'f';return response({id:'job-'+accountId,accountId,status:'running',stage:'notes'});}
  if(path==='/api/accounts/j/sync/job-j')return response({id:'job-j',accountId:'j',status:'complete'});
  if(path==='/api/accounts/f/sync/job-f'){
   activeReads++;maxReads=Math.max(maxReads,activeReads);
   return new Promise<Response>((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>{activeReads--;reject(new DOMException('Aborted','AbortError'));},{once:true}));
  }
 });
 await openAccounts();await waitFor(()=>expect(card('JINGHUI').getByRole('status')).toHaveTextContent('同步完成'));
 expect(maxReads).toBe(1);expect(activeReads).toBe(1);
 cleanup();expect(activeReads).toBe(0);
});

test('shows running stage and saved counts instead of concealing progress behind generic text',async()=>{
 const job={id:'job-j',accountId:'j',status:'running',stage:'comments',message:'正在读取最新评论',counts:{notes:12,comments:3,messages:0}};
 fixture(path=>path==='/api/accounts/j/sync/latest'||path==='/api/accounts/j/sync/job-j'?response(job):undefined);
 await openAccounts();
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('正在读取最新评论');
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('评论');
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('内容 12');
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('评论 3');
});

test('does not let late initial status loading erase freshly submitted account results',async()=>{
 let finishInitial:((value:Response)=>void)|undefined;
 fixture(path=>{
  if(path==='/api/accounts/j/sync/latest')return new Promise<Response>(resolve=>{finishInitial=resolve;});
  if(path==='/api/accounts/j/sync'||path==='/api/accounts/f/sync'){const accountId=path.includes('/j/')?'j':'f';return response({id:'job-'+accountId,accountId,status:'complete',counts:{notes:2}});}
 });
 await openAccounts();fireEvent.click(screen.getByRole('button',{name:'同步全部账号'}));
 await waitFor(()=>expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('同步完成'));
 await act(async()=>finishInitial?.(response(null)));
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('同步完成');
 expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('同步完成');
});

test('shows initial status read failures on the affected account without calling its sync failed',async()=>{
 fixture(path=>path==='/api/accounts/j/sync/latest'?response({message:'账号状态暂不可用'},503):path==='/api/accounts/f/sync/latest'?response({id:'job-f',accountId:'f',status:'complete',counts:{notes:2}}):undefined);
 await openAccounts();
 await waitFor(()=>expect(card('JINGHUI').getByRole('status')).toHaveTextContent('状态读取中断'));
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('账号状态暂不可用');
 expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('同步完成');
});

test('keeps the second account paused for scanning and resumes both once on the verified computer',async()=>{
 let authenticated=false,jStarts=0;
 const fetcher=fixture(path=>{
  if(path==='/api/accounts/j/sync')return response(++jStarts===1?{loginRequired:true,loginJob:{id:'login-j',accountId:'j',deviceId:'d',deviceName:'测试电脑',status:'waiting_scan',message:'请完成 JINGHUI 登录'}}:{id:'job-j',accountId:'j',status:'complete',counts:{notes:2}});
  if(path==='/api/xhs/qr-login/login-j')return response({id:'login-j',accountId:'j',deviceId:'d',deviceName:'测试电脑',status:authenticated?'authenticated':'waiting_scan',account:authenticated?accounts[0]:undefined,message:'请完成 JINGHUI 登录'});
  if(path==='/api/accounts/f/sync')return response({id:'job-f',accountId:'f',status:'complete',counts:{notes:3}});
 });
 await openAccounts();vi.useFakeTimers();fireEvent.click(screen.getByRole('button',{name:'同步全部账号'}));await act(async()=>{});
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('扫码');
 expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('暂停');
 expect(fetcher.mock.calls.some(([url])=>String(url)==='/api/accounts/f/sync')).toBe(false);
 authenticated=true;await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('同步完成');
 expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('同步完成');
 expect(fetcher.mock.calls.filter(([url])=>String(url)==='/api/accounts/f/sync')).toHaveLength(1);
 expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith('/sync')).map(([,options])=>JSON.parse(String(options?.body)))).toEqual([{deviceId:'d'},{deviceId:'d'},{deviceId:'d'}]);
});

test('leaves remaining accounts visibly paused after a server restriction',async()=>{
 const fetcher=fixture(path=>path==='/api/accounts/j/sync'?response({id:'job-j',accountId:'j',status:'blocked',stage:'queued',queuePosition:2,message:'账号限制，已暂停同步'}):undefined);
 await openAccounts();fireEvent.click(screen.getByRole('button',{name:'同步全部账号'}));
 await waitFor(()=>expect(card('JINGHUI').getByRole('status')).toHaveTextContent('账号限制'));
 expect(card('JINGHUI').getByRole('status')).not.toHaveTextContent('等待执行电脑');
 expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('暂停');
 expect(fetcher.mock.calls.some(([url])=>String(url)==='/api/accounts/f/sync')).toBe(false);
});

test('does not resume a failed batch when an independent account reconnect later finishes',async()=>{
 let jStarts=0;
 const fetcher=fixture((path,options)=>{
  if(path==='/api/accounts/j/sync')return ++jStarts===1?response({message:'执行电脑暂不可用'},503):response({id:'job-j',accountId:'j',status:'complete',counts:{notes:2}});
  if(path==='/api/xhs/qr-login'&&options?.method==='POST')return response({id:'manual-login',accountId:'j',deviceId:'d',status:'waiting_scan',message:'请扫码'});
  if(path==='/api/xhs/qr-login/manual-login')return response({id:'manual-login',accountId:'j',deviceId:'d',status:'authenticated',account:accounts[0]});
 });
 await openAccounts();fireEvent.click(screen.getByRole('button',{name:'同步全部账号'}));
 await waitFor(()=>expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('暂停'));
 vi.useFakeTimers();fireEvent.change(screen.getByRole('combobox',{name:'扫码目标账号'}),{target:{value:'j'}});fireEvent.click(screen.getByRole('button',{name:'打开浏览器并连接账号'}));await act(async()=>{});
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('同步完成');
 expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('暂停');
 expect(fetcher.mock.calls.some(([url])=>String(url)==='/api/accounts/f/sync')).toBe(false);
});

test('keeps batch actions disabled while checking the verified login before resuming',async()=>{
 let jStarts=0,reads=0,finishRefresh:((value:Response)=>void)|undefined;
 fixture(path=>{
  if(path==='/api/operations'&&++reads===2)return new Promise<Response>(resolve=>{finishRefresh=resolve;});
  if(path==='/api/accounts/j/sync')return response(++jStarts===1?{loginRequired:true,loginJob:{id:'login-j',accountId:'j',deviceId:'d',status:'waiting_scan',message:'请扫码'}}:{id:'job-j',accountId:'j',status:'complete'});
  if(path==='/api/xhs/qr-login/login-j')return response({id:'login-j',accountId:'j',deviceId:'d',status:'authenticated',account:accounts[0]});
  if(path==='/api/accounts/f/sync')return response({id:'job-f',accountId:'f',status:'complete'});
 });
 await openAccounts();vi.useFakeTimers();fireEvent.click(screen.getByRole('button',{name:'同步全部账号'}));await act(async()=>{});
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
 expect(screen.getByRole('button',{name:/同步全部账号/})).toBeDisabled();
 expect(card('JINGHUI').getByRole('button',{name:'开始同步'})).toBeDisabled();
 await act(async()=>finishRefresh?.(response({accounts,notes:[],comments:[],leads:[]})));
 expect(card('FJINGHUI').getByRole('status')).toHaveTextContent('同步完成');
});

test('shows execution queue position as waiting instead of reporting content collection',async()=>{
 const job={id:'job-j',accountId:'j',status:'running',stage:'queued',queuePosition:2,message:'前面还有 1 个账号等待执行',counts:{notes:0,comments:0,messages:0}};
 fixture(path=>path==='/api/accounts/j/sync/latest'||path==='/api/accounts/j/sync/job-j'?response(job):undefined);
 await openAccounts();
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('等待执行电脑');
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('排队位置 2');
 expect(card('JINGHUI').getByRole('status')).toHaveTextContent('前面还有 1 个账号等待执行');
 expect(card('JINGHUI').getByRole('status')).not.toHaveTextContent('正在同步内容');
});

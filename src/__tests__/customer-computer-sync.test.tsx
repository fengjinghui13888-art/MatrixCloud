import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {GreyApp} from '../GreyApp';
test('continues sync once on the same Windows computer after login verification',async()=>{
 const account={id:'xhs-123',name:'我的账号',handle:'123',profile:'local:old-mac',avatar:'',followers:2,lastSyncedAt:'',state:'connected',executionDevice:{id:'mac',name:'管理 Mac',online:true}};
 const operations={accounts:[account],notes:[],comments:[],leads:[]};
 let syncCount=0;const syncBodies:any[]=[];
 const original=globalThis.fetch;const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
 globalThis.fetch=vi.fn(async(url,options)=>{
  const path=String(url);let value:any=null;
  if(path==='/api/auth/status')value={configured:true};
  else if(path==='/api/auth/session')value={username:'fixture'};
  else if(path==='/api/operations')value=operations;
  else if(path==='/api/accounts')value=[account];
  else if(path==='/api/connector/devices')value={selectedDeviceId:'windows',devices:[{id:'windows',name:'客户 Windows',platform:'win32',version:'3.0.1',online:true,executionReady:true,revoked:false}]};
  else if(path==='/api/connector/capabilities')value={secure:true};
  else if(path==='/api/accounts/xhs-123/sync'){
   syncBodies.push(JSON.parse(String(options?.body)));syncCount++;
   value=syncCount===1?{loginRequired:true,loginJob:{id:'login-win',accountId:account.id,deviceId:'windows',deviceName:'客户 Windows',status:'waiting_scan',message:'请在客户 Windows 登录'}}:{id:'sync-win',accountId:account.id,status:'complete',counts:{notes:1}};
  }else if(path==='/api/xhs/qr-login/login-win')value={id:'login-win',deviceId:'windows',deviceName:'客户 Windows',status:'authenticated',account,message:'已验证账号'};
  return new Response(JSON.stringify(value));
 });
 try{
  render(<GreyApp/>);await screen.findByText('已同步账号');
  fireEvent.click(screen.getByRole('button',{name:'账号矩阵'}));
  fireEvent.click(await screen.findByRole('button',{name:'开始同步'}));
  await screen.findByText('请在客户 Windows 登录');
  await waitFor(()=>expect(syncCount).toBe(2));
  expect(syncBodies[1]).toEqual({deviceId:'windows'});
  expect(await screen.findAllByText(/同步完成.*内容 1/)).not.toHaveLength(0);
 }finally{globalThis.fetch=original;confirm.mockRestore();}
});

test('shows an offline bound account without claiming it is connected',async()=>{
 const account={id:'xhs-offline',name:'离线账号',handle:'offline',profile:'local:offline',avatar:'',followers:0,lastSyncedAt:'',state:'connected',executionDevice:{id:'old-device',name:'旧电脑',online:false}};
 const original=globalThis.fetch;
 globalThis.fetch=vi.fn(async url=>{
  const path=String(url);let value:any=null;
  if(path==='/api/auth/status')value={configured:true};
  else if(path==='/api/auth/session')value={username:'fixture'};
  else if(path==='/api/operations')value={accounts:[account],notes:[],comments:[],leads:[]};
  else if(path==='/api/accounts')value=[account];
  else if(path==='/api/accounts/xhs-offline/sync/latest')value=null;
  else if(path==='/api/connector/devices')value={selectedDeviceId:'old-device',devices:[{id:'old-device',name:'旧电脑',platform:'win32',version:'4.0.0',online:false,executionReady:false,revoked:false}]};
  else if(path==='/api/connector/capabilities')value={secure:true};
  return new Response(JSON.stringify(value));
 });
 try{
  render(<GreyApp/>);
  fireEvent.click(await screen.findByRole('button',{name:'账号矩阵'}));
  expect(await screen.findByText(/执行电脑离线/)).toBeInTheDocument();
  expect(screen.getByText(/请先在执行电脑启动连接器/)).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'重新连接'})).toBeInTheDocument();
  expect(screen.queryByText('offline · 0 粉丝 · 已连接')).not.toBeInTheDocument();
 }finally{globalThis.fetch=original;}
});

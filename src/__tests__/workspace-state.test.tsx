import {act,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {GreyApp} from '../GreyApp';

test('a late running response cannot overwrite a confirmed stop',async()=>{
 const account={id:'a',name:'测试账号',handle:'123',profile:'local:a',followers:0,lastSyncedAt:''};
 const original=globalThis.fetch;let finishPoll:((v:Response)=>void)|undefined,finishStop:((v:Response)=>void)|undefined;
 globalThis.fetch=vi.fn(async url=>{
  const path=String(url);let value:any=null;
  if(path==='/api/auth/status')value={configured:true};
  if(path==='/api/auth/session')value={username:'fixture'};
  if(path==='/api/operations')value={accounts:[account],notes:[],comments:[],leads:[]};
  if(path==='/api/accounts')value=[account];
  if(path==='/api/accounts/a/sync/latest')value={id:'job',accountId:'a',status:'running'};
  if(path==='/api/accounts/a/sync/job')return new Promise<Response>(resolve=>{finishPoll=resolve;});
  if(path==='/api/accounts/a/sync/job/cancel')return new Promise<Response>(resolve=>{finishStop=resolve;});
  return new Response(JSON.stringify(value));
 });
 try{
  render(<GreyApp/>);fireEvent.click(await screen.findByRole('button',{name:'停止'}));
  await screen.findByText('正在停止，等待执行电脑确认…');
  await act(async()=>finishStop?.(new Response(JSON.stringify({id:'job',accountId:'a',status:'blocked',message:'停止已确认'}))));
  await screen.findByText('停止已确认');
  await act(async()=>finishPoll?.(new Response(JSON.stringify({id:'job',accountId:'a',status:'running'}))));
  expect(screen.getByText('停止已确认')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'同步最新数据'})).toBeEnabled();
 }finally{globalThis.fetch=original;}
});

test('continues tracking a stopping job until the computer confirms completion',async()=>{
 const account={id:'a',name:'测试账号',handle:'123',profile:'local:a',followers:0,lastSyncedAt:'',executionDevice:{id:'d',name:'测试电脑',online:true}};
 let polls=0;
 const original=globalThis.fetch;
 globalThis.fetch=vi.fn(async url=>{
  const path=String(url);let value:any=null;
  if(path==='/api/auth/status')value={configured:true};
  if(path==='/api/auth/session')value={username:'fixture'};
  if(path==='/api/operations')value={accounts:[account],notes:[],comments:[],leads:[]};
  if(path==='/api/accounts')value=[account];
  if(path==='/api/accounts/a/sync/latest')value={id:'job',accountId:'a',status:'stopping'};
  if(path==='/api/accounts/a/sync/job')value={id:'job',accountId:'a',status:++polls===1?'stopping':'cancelled'};
  return new Response(JSON.stringify(value));
 });
 try{
  render(<GreyApp/>);await screen.findByText('正在停止，等待执行电脑确认…');
  expect(screen.getByRole('button',{name:'同步进行中…'})).toBeDisabled();
  await screen.findByText('同步已停止',{}, {timeout:3000});expect(polls).toBe(2);
  await waitFor(()=>expect(screen.getByRole('button',{name:'同步最新数据'})).toBeEnabled());
 }finally{globalThis.fetch=original;}
});

test('returns to a populated page and clears selection after deleting the last note on page two',async()=>{
 const account={id:'a',name:'测试账号',handle:'123',profile:'local:a',followers:0,lastSyncedAt:''};
 let notes=Array.from({length:13},(_,i)=>({id:'n'+i,accountId:'a',title:'笔记'+i,body:'正文',images:[],type:'image',createdAt:'2026-09-17',publishedAt:'2026-09-17',metrics:{},tags:[]}));
 const original=globalThis.fetch,confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
 globalThis.fetch=vi.fn(async(url,options)=>{
  const path=String(url);let value:any=null;
  if(path==='/api/auth/status')value={configured:true};
  if(path==='/api/auth/session')value={username:'fixture'};
  if(path==='/api/operations')value={accounts:[account],notes,comments:[],leads:[]};
  if(path==='/api/accounts')value=[account];
  if(path==='/api/notes/bulk-delete'){const ids=JSON.parse(String(options?.body)).items.map((n:any)=>n.noteId);notes=notes.filter(n=>!ids.includes(n.id));value={ok:true};}
  return new Response(JSON.stringify(value));
 });
 try{
  render(<GreyApp/>);await screen.findByText('已同步账号');fireEvent.click(screen.getByRole('button',{name:'内容管理'}));
  fireEvent.click(screen.getByRole('button',{name:'下一页'}));
  fireEvent.click(screen.getByRole('checkbox',{name:'选择内容 笔记12'}));
  fireEvent.click(screen.getByRole('button',{name:'批量删除内容（1）'}));
  await screen.findByRole('checkbox',{name:'选择内容 笔记0'});
  expect(screen.queryByText('还没有同步内容')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'批量删除内容（0）'})).toBeDisabled();
 }finally{globalThis.fetch=original;confirm.mockRestore();}
});

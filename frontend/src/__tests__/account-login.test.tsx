import { act,cleanup,render,screen,fireEvent } from '@testing-library/react';
import { AccountLogin } from '../AccountLogin';
import { GreyApp } from '../GreyApp';

afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();sessionStorage.clear();});

function accountView(){
  return <AccountLogin>{(username,logout,switchAccount)=><div>
    <p>当前账号：{username}</p>
    <button onClick={()=>void logout().catch(()=>{})}>退出当前账号</button>
    <button onClick={()=>void switchAccount()}>切换当前账号</button>
  </div>}</AccountLogin>;
}

function authResponse(path:RequestInfo|URL){
  if(path==='/api/auth/status')return new Response(JSON.stringify({configured:true,setupAllowed:false}));
  if(path==='/api/auth/session')return new Response(JSON.stringify({message:'请登录'}),{status:401});
  return new Response(JSON.stringify({username:'customer'}));
}

async function flushAccountRequests(){await act(async()=>{await Promise.resolve();});}

function enterCredentials(password:string,register=false){
  if(register)fireEvent.click(screen.getByRole('button',{name:'创建新账号'}));
  fireEvent.change(screen.getByLabelText('账号'),{target:{value:'customer'}});
  fireEvent.change(screen.getByLabelText('密码'),{target:{value:password}});
  if(register)fireEvent.change(screen.getByLabelText('确认密码'),{target:{value:password}});
}

test.each([
  ['73 ASCII bytes','a'.repeat(73),/72.*字节/],
  ['75 UTF-8 bytes','密'.repeat(25),/72.*字节/],
  ['six emoji characters','😀'.repeat(6),/12.*字符/],
  ['eleven ASCII characters','a'.repeat(11),/12.*字符/],
])('registration rejects %s before sending a request',async(_name,password,message)=>{
  const submitted:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(path:RequestInfo|URL)=>{if(path==='/api/auth/register')submitted.push(String(path));return authResponse(path);}));
  render(accountView());await screen.findByLabelText('账号');
  enterCredentials(password,true);
  fireEvent.submit(screen.getByRole('button',{name:'创建账号并进入'}).closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(submitted).toEqual([]);
  expect(screen.getByRole('button',{name:'创建账号并进入'})).toBeEnabled();
});

test.each([
  ['72 ASCII bytes','a'.repeat(72)],
  ['72 UTF-8 bytes','密'.repeat(24)],
  ['twelve emoji characters','😀'.repeat(12)],
])('registration accepts %s and explains its byte limit',async(_name,password)=>{
  let submitted:unknown;
  vi.stubGlobal('fetch',vi.fn(async(path:RequestInfo|URL,init?:RequestInit)=>{if(path==='/api/auth/register')submitted=JSON.parse(String(init?.body));return authResponse(path);}));
  render(accountView());await screen.findByLabelText('账号');
  enterCredentials(password,true);
  expect(screen.getByText(/UTF-8.*72.*字节/)).toBeInTheDocument();
  fireEvent.submit(screen.getByRole('button',{name:'创建账号并进入'}).closest('form')!);
  await screen.findByText('当前账号：customer');
  expect(submitted).toEqual({username:'customer',password});
});

test('login still accepts a legacy password with 128 characters',async()=>{
  const password='密'.repeat(128);let submitted:unknown;
  vi.stubGlobal('fetch',vi.fn(async(path:RequestInfo|URL,init?:RequestInit)=>{if(path==='/api/auth/login')submitted=JSON.parse(String(init?.body));return authResponse(path);}));
  render(accountView());await screen.findByLabelText('账号');
  enterCredentials(password);
  expect(screen.getByLabelText('密码')).toHaveAttribute('maxlength','128');
  fireEvent.submit(screen.getByRole('button',{name:'登录工作台'}).closest('form')!);
  await screen.findByText('当前账号：customer');
  expect(submitted).toEqual({username:'customer',password});
});

test.each([
  ['status','headers'],['session','headers'],['status','body'],['session','body'],
])('initial %s %s timeout aborts the request and reconnect succeeds',async(endpoint,phase)=>{
  vi.useFakeTimers();let first=true;let stalledSignal:AbortSignal|undefined;
  vi.stubGlobal('fetch',vi.fn((path:RequestInfo|URL,init?:RequestInit)=>{
    if(path===`/api/auth/${endpoint}`&&first){
      first=false;stalledSignal=init?.signal as AbortSignal|undefined;
      if(phase==='headers')return new Promise<Response>(()=>{});
      const response=new Response(JSON.stringify(endpoint==='status'?{configured:true,setupAllowed:false}:{username:'customer'}));
      response.json=()=>new Promise(()=>{});
      return Promise.resolve(response);
    }
    return Promise.resolve(authResponse(path));
  }));
  render(accountView());await flushAccountRequests();
  await act(async()=>{await vi.advanceTimersByTimeAsync(15_000);});
  expect(stalledSignal?.aborted).toBe(true);
  expect(screen.getByRole('alert')).toHaveTextContent(/超时.*重试/);
  fireEvent.click(screen.getByRole('button',{name:'重新连接'}));await flushAccountRequests();
  expect(screen.getByRole('button',{name:'登录工作台'})).toBeEnabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test.each([
  ['register','headers'],['register','body'],['login','headers'],['login','body'],
])('%s %s timeout aborts the request and restores a retryable submit button',async(endpoint,phase)=>{
  vi.useFakeTimers();let first=true;let stalledSignal:AbortSignal|undefined;
  vi.stubGlobal('fetch',vi.fn((path:RequestInfo|URL,init?:RequestInit)=>{
    if(path===`/api/auth/${endpoint}`&&first){
      first=false;stalledSignal=init?.signal as AbortSignal|undefined;
      if(phase==='headers')return new Promise<Response>(()=>{});
      const response=authResponse(path);response.json=()=>new Promise(()=>{});return Promise.resolve(response);
    }
    return Promise.resolve(authResponse(path));
  }));
  render(accountView());await flushAccountRequests();
  const register=endpoint==='register',buttonName=register?'创建账号并进入':'登录工作台';
  enterCredentials('fixture-password-123',register);
  fireEvent.submit(screen.getByRole('button',{name:buttonName}).closest('form')!);await flushAccountRequests();
  expect(screen.getByRole('button',{name:'正在处理…'})).toBeDisabled();
  await act(async()=>{await vi.advanceTimersByTimeAsync(15_000);});
  expect(stalledSignal?.aborted).toBe(true);
  expect(screen.getByRole('alert')).toHaveTextContent(/超时.*重试/);
  expect(screen.getByRole('button',{name:buttonName})).toBeEnabled();
  fireEvent.submit(screen.getByRole('button',{name:buttonName}).closest('form')!);await flushAccountRequests();
  expect(screen.getByText('当前账号：customer')).toBeInTheDocument();
});

test.each(['退出当前账号','切换当前账号'])('%s timeout keeps the current identity and pairing hint until retry succeeds',async(action)=>{
  vi.useFakeTimers();let first=true;let stalledSignal:AbortSignal|undefined;
  sessionStorage.setItem('matrix.pendingPairing','pending-device');
  vi.stubGlobal('fetch',vi.fn((path:RequestInfo|URL,init?:RequestInit)=>{
    if(path==='/api/auth/session')return Promise.resolve(new Response(JSON.stringify({username:'customer'})));
    if(path==='/api/auth/logout'&&first){first=false;stalledSignal=init?.signal as AbortSignal|undefined;return new Promise<Response>(()=>{});}
    return Promise.resolve(authResponse(path));
  }));
  render(accountView());await flushAccountRequests();
  fireEvent.click(screen.getByRole('button',{name:action}));await flushAccountRequests();
  await act(async()=>{await vi.advanceTimersByTimeAsync(15_000);});
  expect(stalledSignal?.aborted).toBe(true);
  expect(screen.getByText('当前账号：customer')).toBeInTheDocument();
  expect(sessionStorage.getItem('matrix.pendingPairing')).toBe('pending-device');
  expect(screen.getByRole('alert')).toHaveTextContent(/超时.*重试/);
  fireEvent.click(screen.getByRole('button',{name:action}));await flushAccountRequests();
  expect(screen.getByRole('button',{name:'登录工作台'})).toBeEnabled();
  expect(screen.queryByText('当前账号：customer')).not.toBeInTheDocument();
  expect(sessionStorage.getItem('matrix.pendingPairing')).toBeNull();
});

test('normal account login restores on remount and logout returns to password form',async()=>{
  const original=globalThis.fetch;let loggedIn=false;
  globalThis.fetch=vi.fn(async(url)=>{
    if(url==='/api/auth/status')return new Response(JSON.stringify({configured:true,setupAllowed:false}));
    if(url==='/api/auth/login')loggedIn=true;
    if(url==='/api/auth/logout')loggedIn=false;
    if(url==='/api/operations')return new Response(JSON.stringify({accounts:[],notes:[],comments:[],leads:[]}));
    return new Response(JSON.stringify(loggedIn?{username:'owner'}:{message:'请登录'}),{status:loggedIn||url==='/api/auth/logout'?200:401});
  });
  try{
    const first=render(<GreyApp/>);
    fireEvent.change(await screen.findByLabelText('账号'),{target:{value:'owner'}});
    fireEvent.change(screen.getByLabelText('密码'),{target:{value:'fixture-password-123'}});
    fireEvent.click(screen.getByRole('button',{name:'登录工作台'}));
    await screen.findByText('已同步账号');first.unmount();
    render(<GreyApp/>);await screen.findByText('已同步账号');
    expect(screen.queryByLabelText('访问令牌')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'退出登录'}));
    expect(await screen.findByLabelText('密码')).toHaveValue('');
  }finally{globalThis.fetch=original;}
});

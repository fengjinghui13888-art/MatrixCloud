import {act,render,fireEvent,screen,waitFor} from '@testing-library/react';
import {ConnectorAuthorize} from '../ConnectorAuthorize';
import {GreyApp} from '../GreyApp';

test('opens connector authorization when its link arrives in an already loaded workspace',async()=>{
 const original=globalThis.fetch;
 history.replaceState(null,'','/');sessionStorage.clear();
 globalThis.fetch=vi.fn(async url=>{
  const path=String(url);
  const value=path==='/api/auth/status'?{configured:true}:path==='/api/auth/session'?{username:'fixture'}:path==='/api/operations'?{accounts:[],notes:[],comments:[],leads:[]}:path==='/api/connector/devices'?{devices:[]}:path==='/api/connector/capabilities'?{secure:true}:{};
  return new Response(JSON.stringify(value));
 });
 try{
  render(<GreyApp/>);
  await screen.findByRole('heading',{name:'经营概览',level:1});
  expect(screen.queryByRole('button',{name:'授权连接这台电脑'})).not.toBeInTheDocument();
  await act(async()=>{window.location.hash='#connectorSetup='+'b'.repeat(64);window.dispatchEvent(new HashChangeEvent('hashchange'));});
  expect(await screen.findByRole('button',{name:'授权连接这台电脑'})).toBeInTheDocument();
  expect(screen.getByRole('heading',{name:'账号矩阵',level:1})).toBeInTheDocument();
  expect(window.location.hash).toBe('');
  fireEvent.click(screen.getByRole('button',{name:'内容管理'}));
  expect(screen.getByRole('heading',{name:'内容管理',level:1})).toBeInTheDocument();
  await act(async()=>{window.location.hash='#connectorSetup='+'b'.repeat(64);window.dispatchEvent(new HashChangeEvent('hashchange'));});
  expect(await screen.findByRole('button',{name:'授权连接这台电脑'})).toBeInTheDocument();
  expect(screen.getByRole('heading',{name:'账号矩阵',level:1})).toBeInTheDocument();
  expect(window.location.hash).toBe('');
 }finally{globalThis.fetch=original;history.replaceState(null,'','/');sessionStorage.clear();}
});
test('only submits a one-use pairing after explicit authorization, without manual server settings',async()=>{
 const request=vi.fn().mockResolvedValue({id:'pair-id',code:'12345678',expiresAt:Date.now()+300000});
 const navigations:string[]=[];
 const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this:HTMLAnchorElement){navigations.push(this.href);});
 try{
  render(<ConnectorAuthorize nonce={'a'.repeat(64)} request={request}/>);
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'授权连接这台电脑'}));
  await waitFor(()=>expect(navigations).toHaveLength(1));
  const target=new URL(navigations[0]);
  expect(target.origin+target.pathname).toBe('http://127.0.0.1:47821/onboarding');
  expect(target.searchParams.get('nonce')).toBe('a'.repeat(64));
  expect(target.searchParams.get('code')).toBe('12345678');
  expect(JSON.parse(sessionStorage.getItem('matrix.pendingPairing')!)).toMatchObject({id:'pair-id',status:'pending'});
 }finally{click.mockRestore();sessionStorage.clear();}
});

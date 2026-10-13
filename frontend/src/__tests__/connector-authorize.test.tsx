import {render,fireEvent,screen,waitFor} from '@testing-library/react';
import {ConnectorAuthorize} from '../ConnectorAuthorize';
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

import { render,screen,fireEvent,waitFor } from '@testing-library/react';
import { GreyApp } from '../GreyApp';

test('follow-up drafts stay with their own lead and clear only after successful save',async()=>{
  const original=globalThis.fetch;
  const fetchMock=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
    if(url==='/api/auth/status')return new Response(JSON.stringify({configured:true}));
    if(url==='/api/auth/session')return new Response(JSON.stringify({username:'tester'}));
    if(init?.method==='POST')return new Response('{}');
    return new Response(JSON.stringify({accounts:[{id:'a',name:'Account'}],notes:[],comments:[],leads:['one','two'].map(id=>({id,accountId:'a',status:'new',followUps:[]}))}));
  });
  globalThis.fetch=fetchMock;
  try{
    render(<GreyApp/>);
    await screen.findByText('已同步账号');
    fireEvent.click(screen.getByRole('button',{name:'线索中心'}));
    fireEvent.change(screen.getByLabelText('跟进 one'),{target:{value:'第一条沟通'}});
    expect(screen.getByLabelText('跟进 two')).toHaveValue('');
    expect(screen.getAllByRole('button',{name:'保存跟进'})[1]).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button',{name:'保存跟进'})[0]);
    await waitFor(()=>expect(screen.getByLabelText('跟进 one')).toHaveValue(''));
    expect(fetchMock).toHaveBeenCalledWith('/api/leads/one/follow-ups',expect.objectContaining({body:JSON.stringify({body:'第一条沟通'})}));
  }finally{globalThis.fetch=original;}
});

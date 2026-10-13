import { render,screen,fireEvent } from '@testing-library/react';
import { GreyApp } from '../GreyApp';

test('private messages follow the selected social account in the interaction board',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=vi.fn(async(url)=>new Response(JSON.stringify(url==='/api/auth/status'?{configured:true}:url==='/api/auth/session'?{username:'fixture'}:{accounts:[{id:'a1',name:'One',handle:'1'},{id:'a2',name:'Two',handle:'2'}],notes:[],comments:[],leads:[],messages:[{id:'m1',accountId:'a1',conversationId:'c1',author:'Reader one',body:'First private message',direction:'incoming',createdAt:'today'},{id:'m2',accountId:'a2',conversationId:'c2',author:'Reader two',body:'Second private message',direction:'incoming',createdAt:'today'}]})));
  try{
    render(<GreyApp/>);await screen.findByText('已同步账号');
    fireEvent.click(screen.getByRole('button',{name:'互动管理'}));
    expect(screen.getByText('First private message')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox',{name:'账号范围'}),{target:{value:'a2'}});
    expect(screen.queryByText('First private message')).not.toBeInTheDocument();
    expect(screen.getByText('Second private message')).toBeInTheDocument();
  }finally{globalThis.fetch=original;}
});

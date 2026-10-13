import { render,screen,fireEvent,within } from '@testing-library/react';
import { GreyApp } from '../GreyApp';

test('content library shows captured cover and opens readable body without inventing missing content',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=vi.fn(async(url)=>{
    if(url==='/api/auth/status')return new Response(JSON.stringify({configured:true}));
    if(url==='/api/auth/session')return new Response(JSON.stringify({username:'fixture'}));
    return new Response(JSON.stringify({accounts:[{id:'fixture',name:'Fixture account'}],notes:[{id:'fixture-note',accountId:'fixture',title:'Fixture title',summary:'Actual fixture body',cover:'https://example.com/cover.jpg',url:null,publishedAt:'2026-09-01',metrics:{likes:null,collects:null,comments:null,shares:null}}],comments:[],leads:[]}));
  });
  try{
    render(<GreyApp/>);
    await screen.findByText('已同步账号');
    fireEvent.click(screen.getByRole('button',{name:'内容管理'}));
    expect(screen.getByRole('img',{name:'Fixture title 的封面'})).toHaveAttribute('src','https://example.com/cover.jpg');
    fireEvent.click(screen.getByRole('button',{name:'阅读 Fixture title'}));
    const detail=screen.getByRole('dialog',{name:'Fixture title'});
    expect(within(detail).getByText('Actual fixture body')).toBeInTheDocument();
    expect(within(detail).queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button',{name:'关闭详情'}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  }finally{globalThis.fetch=original;}
});

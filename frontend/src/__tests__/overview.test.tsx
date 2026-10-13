import { render,screen,fireEvent } from '@testing-library/react';
import { Overview } from '../Overview';

test('overview charts show observed note counts and unknown interaction data, with account drill down',()=>{
  const onAccount=vi.fn();
  const accounts=['a','b'].map(id=>({id,name:'同名账号',handle:id,avatar:'',profile:id,state:'connected' as const,followers:1,lastSyncedAt:''}));
  const notes=[{id:'n',accountId:'a',title:'笔记',summary:null,cover:null,url:null,publishedAt:'',metrics:{likes:null,collects:null,comments:null,shares:null}}];
  render(<Overview accounts={accounts} notes={notes} comments={[]} leads={[]} onAccount={onAccount} onNavigate={()=>{}}/>);
  expect(screen.getByRole('img',{name:'各账号已收录内容数量'})).toBeInTheDocument();
  expect(screen.getByText('互动数据尚未采集')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'查看 同名账号 · a 的内容：1 篇'}));
  expect(onAccount).toHaveBeenCalledWith('a');
});

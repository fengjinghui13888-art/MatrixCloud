import { render,screen,fireEvent } from '@testing-library/react';
import { PublishCenter } from '../PublishCenter';

test('reviewed content stays editable and never presents an automatic publish action',async()=>{
  const request=async(path:string)=>path==='studio'?[{id:'fixture',revision:1,accountId:'xhs:1',topic:'通勤背包',persona:'真实体验',style:'自然',imageCount:1,size:'1024x1536',status:'review',title:'轻装通勤',body:'生成正文',tags:['通勤'],images:['https://example.com/generated.png'],message:'待审核'}]:[];
  render(<PublishCenter accounts={[]} request={request}/>);
  fireEvent.click(screen.getByRole('tab',{name:'图文创作'}));
  fireEvent.click(await screen.findByRole('button',{name:'轻装通勤'}));
  expect(screen.getByLabelText('正文')).toHaveValue('生成正文');
  expect(screen.getByAltText('生成配图 1')).toHaveAttribute('src','https://example.com/generated.png');
  expect(screen.getByRole('button',{name:'保存到小红书草稿'})).toBeEnabled();
  expect(screen.queryByRole('button',{name:'发布到小红书'})).not.toBeInTheDocument();
});

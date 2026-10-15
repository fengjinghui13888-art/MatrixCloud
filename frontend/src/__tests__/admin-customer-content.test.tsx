import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {AdminCustomerContent} from '../../admin/AdminCustomerContent';

test('admin browses scoped notes comments and messages without requesting live sync',async()=>{
 const request=vi.fn(async(path:string,body?:object)=>{
  if(path==='customers/tenant/accounts')return {items:[{id:'account',name:'合成账号',handle:'123',executionDevice:{name:'客户电脑',online:true}}]};
  if(path.endsWith('/sync'))return {job:{id:'job',status:'running',message:'正在拉取'}};
  if(path.endsWith('/sync-status'))return {job:null};
  return {items:[path.includes('/notes?')?{id:'n',title:'已同步笔记',summary:'正文',media:[{id:'m',kind:'image',url:'/api/platform-admin/test-image'}]}:path.includes('/comments?')?{id:'c',author:'评论用户',body:'评论正文'}:{id:'m',author:'私信用户',body:'私信正文',direction:'incoming'}],total:1,hasNext:false};
 });
 render(<AdminCustomerContent tenant="tenant" request={request}/>);
 await screen.findByText('已同步笔记');expect(screen.getByRole('img')).toHaveAttribute('src','/api/platform-admin/test-image');
 fireEvent.click(screen.getByRole('button',{name:'评论记录'}));await screen.findByText('评论正文');expect(screen.queryByText('已同步笔记')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'私信记录'}));await screen.findByText('私信正文');
 expect(screen.queryByRole('button',{name:'拉取最新数据'})).not.toBeInTheDocument();
 expect(request.mock.calls.every(call=>!call[1]&&!call[0].includes('/sync'))).toBe(true);
});

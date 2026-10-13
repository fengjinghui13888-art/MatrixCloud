import { useState } from 'react';
import {copyText} from './safe-clipboard';

export function SyncGuide(){
  const [message,setMessage]=useState('');
  const instruction='请读取当前已登录的小红书账号，获取真实笔记、正文、封面、原文链接和可见互动数据，只同步实际读取到的信息，未知字段传 null，不生成演示数据。完成后回到工作台刷新数据。本次不发布、不保存草稿、不回复评论。';
  return <section className="grey-panel"><h3>同步到工作台</h3><p>按下面的说明读取真实账号数据，完成后回到这里刷新数据。</p><textarea aria-label="同步说明" readOnly value={instruction} style={{width:'100%',minHeight:140,background:'#101715',color:'#c2cec7',padding:12,border:'1px solid #35463e',borderRadius:8,lineHeight:1.7}}/><button className="ghost" onClick={async()=>{setMessage(await copyText(instruction)?'说明已复制。':'无法自动复制，请选中上方文字手动复制。');}}>复制说明</button>{message&&<p role="status">{message}</p>}<p className="media-caption">“刷新真实数据”只读取已保存的记录。</p></section>;
}

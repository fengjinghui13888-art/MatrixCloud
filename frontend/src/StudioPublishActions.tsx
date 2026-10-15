
import type {Account} from '../contracts/domain';
import {canRetryStudio} from '../contracts/studio-recovery';
import {useState} from 'react';

type Task={status:string;accountId:string;message:string;executionStartedAt?:string;executionRunId?:string;waitingForSync?:boolean};
type Props={task:Task;accounts:Account[];busy:boolean;dirty:boolean;onAction:(name:string,body:object)=>Promise<void>;onDispatch:(ids:string[])=>Promise<void>};

export function StudioPublishActions({task,accounts,busy,dirty,onAction,onDispatch}:Props){

 const running=!!task.waitingForSync||task.status==='filling'||(task.status==='approved'&&!!task.executionStartedAt);
 const canBatch=!running&&['review','approved','filled'].includes(task.status);
 const review=['review','rejected'].includes(task.status);
 const targets=accounts.filter(a=>a.profile.startsWith('local:'));
 const [selected,setSelected]=useState<string[]>([task.accountId]);
 const selectedIds=selected.filter(id=>targets.some(a=>a.id===id));
 const action=canRetryStudio(task)?'retry':task.status==='rejected'?'review':null;
 // Never silently expand the user's selection when more accounts arrive.
 const batch=canBatch&&selectedIds.length>0;

 const hints:Record<string,string>={
  generating:'图文生成完成后，即可核对并保存草稿。',
  generation_failed:'请先完成图文生成，再保存草稿。',
  filled:'此内容已上传过；再次点击会重新上传并保存一份新草稿，上次记录保留。',
  published:'此任务已核实发布，不再重复保存草稿。',
  pending_confirmation:'人工发布结果待核实，核实前不会重复上传。',
  blocked:canRetryStudio(task)?'上次未完成保存，点击后继续自动同步。':'上次草稿结果待核对，请在原执行电脑检查；确认前不会重复上传。',
 };
 const hint=task.waitingForSync?'此账号正在同步内容，草稿任务已排队；同步结束后自动打开草稿窗口，不用再次点击。':running?'正在自动保存草稿，请保持执行电脑在线。需要中止时点击停止。':dirty?'文案有未保存的修改，请先保存文案修改。':canBatch&&!selectedIds.length?'请勾选至少一个要保存草稿的账号。':task.status==='filled'?hints.filled:batch?'只保存到下方勾选的账号；每个账号会建立独立任务。':review?'核对文案和图片后，将保存到此内容的归属账号。':hints[task.status]??(action?'点击后继续安全同步原任务。':'当前任务状态需要核对，暂不能保存草稿。');
 async function save(){
  if(busy||dirty||running)return;
  if(batch){await onDispatch(selectedIds);return;}
  if(action)await onAction(action,action==='review'?{decision:'approve'}:{checkedNotPublished:true});
 }
 return <section className="dispatch-box studio-publish-panel" aria-label="保存草稿">
  <h3>保存草稿</h3>
  <p>自动保存到所选账号专属浏览器的图文草稿箱，正式发布请在小红书完成。草稿不会自动同步到手机。</p>
  <div className="studio-publish-targets" role="status" aria-label="草稿目标">
   <strong>{canBatch?`同步范围：已选择 ${selectedIds.length} 个账号`:`目标账号：${accounts.find(a=>a.id===task.accountId)?.name??'等待账号连接状态'}`}</strong>
   {accounts.some(a=>!a.profile.startsWith('local:'))&&<span>未连接电脑的账号会先提示重新连接</span>}
  </div>
  {canBatch&&<fieldset className="studio-account-choices"><legend>选择要保存草稿的账号</legend>{targets.map(a=><label key={a.id}><input type="checkbox" aria-label={`保存到 ${a.name}`} disabled={busy} checked={selectedIds.includes(a.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,a.id]:ids.filter(id=>id!==a.id))}/><span>{a.name}<small>{a.handle}{a.id===task.accountId?' · 内容归属账号':''}</small></span></label>)}</fieldset>}
  <p id="studio-publish-hint" role="status">{hint}</p>
  <div className="studio-publish-buttons">
   <button className="primary" aria-describedby="studio-publish-hint" disabled={busy||dirty||running||(!batch&&!action)} onClick={()=>void save()}>保存到小红书草稿</button>
   {running&&<button className="ghost" disabled={busy} onClick={()=>void onAction('cancel',{})}>停止保存草稿</button>}
   {task.status==='blocked'&&task.executionRunId&&task.executionStartedAt&&<button className="ghost" disabled={busy} title="确认设备已停止后解除账号占用；旧草稿记录保留，不会重新上传" onClick={()=>void onAction('cancel',{})}>确认停止旧任务</button>}
   {review&&<button className="ghost" disabled={busy||dirty} onClick={()=>void onAction('review',{decision:'reject'})}>驳回</button>}
  </div>
 </section>;
}


import type {Account} from '../contracts/domain';
import {canRetryStudio} from '../contracts/studio-recovery';

type Task={status:string;accountId:string;message:string;executionStartedAt?:string;executionRunId?:string};
type Props={task:Task;accounts:Account[];busy:boolean;dirty:boolean;onAction:(name:string,body:object)=>Promise<void>;onDispatch:(ids:string[])=>Promise<void>};

export function StudioPublishActions({task,accounts,busy,dirty,onAction,onDispatch}:Props){

 const running=task.status==='filling'||(task.status==='approved'&&!!task.executionStartedAt);
 const canBatch=!running&&['review','approved','filled'].includes(task.status);
 const review=['review','rejected'].includes(task.status);
 const targets=accounts.filter(a=>a.profile.startsWith('local:'));
 const allAccountIds=targets.map(a=>a.id);
 const action=canRetryStudio(task)?'retry':task.status==='rejected'?'review':null;
 // A task can briefly render before the account list finishes loading. Keep
 // the action available in that state and let the server perform the final
 // account check; once an account list is present, only connected accounts are
 // eligible for the all-account dispatch.
 const batch=canBatch&&(allAccountIds.length>0||accounts.length===0);

 const hints:Record<string,string>={
  generating:'图文生成完成后，即可核对并保存草稿。',
  generation_failed:'请先完成图文生成，再保存草稿。',
  filled:'此任务已保存草稿，不会重复上传；点击后只为其他尚未保存的账号建立草稿任务。',
  published:'此任务已核实发布，不再重复保存草稿。',
  pending_confirmation:'人工发布结果待核实，核实前不会重复上传。',
  blocked:canRetryStudio(task)?'上次未完成保存，点击后继续自动同步。':'上次草稿结果待核对，请在原执行电脑检查；确认前不会重复上传。',
 };
 const hint=running?'正在自动保存草稿，请保持执行电脑在线。需要中止时点击停止。':dirty?'文案有未保存的修改，请先保存文案修改。':batch?(accounts.length?'核对文案和图片后点击保存，将同步到当前工作区全部已连接账号；每个账号会建立独立任务。':'正在确认可用账号，点击保存后由系统核对连接状态。'):review?'核对文案和图片后点击保存，将同步到当前工作区全部已连接账号。':hints[task.status]??(action?'点击后继续安全同步原任务。':'当前任务状态需要核对，暂不能保存草稿。');
 async function save(){
  if(busy||dirty||running)return;
  if(batch){if(allAccountIds.length)await onDispatch(allAccountIds);else await onAction('review',{decision:'approve'});return;}
  if(action)await onAction(action,{checkedNotPublished:true});
 }
 return <section className="dispatch-box studio-publish-panel" aria-label="保存草稿">
  <h3>保存草稿</h3>
  <p>自动保存到所选账号专属浏览器的图文草稿箱，正式发布请在小红书完成。草稿不会自动同步到手机。</p>
  <div className="studio-publish-targets" role="status" aria-label="草稿目标">
   {accounts.length?<strong>同步范围：全部已连接账号（{targets.length}）</strong>:<strong>同步范围：等待账号连接状态</strong>}
   {accounts.some(a=>!a.profile.startsWith('local:'))&&<span>未连接电脑的账号会先提示重新连接</span>}
  </div>
  {batch&&<p className="studio-publish-account-list">{targets.map(a=>a.name).join('、')}</p>}
  <p id="studio-publish-hint" role="status">{hint}</p>
  <div className="studio-publish-buttons">
   <button className="primary" aria-describedby="studio-publish-hint" disabled={busy||dirty||running||(!batch&&!action)} onClick={()=>void save()}>保存到小红书草稿</button>
   {running&&<button className="ghost" disabled={busy} onClick={()=>void onAction('cancel',{})}>停止保存草稿</button>}
   {review&&<button className="ghost" disabled={busy||dirty} onClick={()=>void onAction('review',{decision:'reject'})}>驳回</button>}
  </div>
 </section>;
}

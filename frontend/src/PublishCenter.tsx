import type { Account } from '../../shared/domain';
import { OneClickPublish } from './OneClickPublish';
import { TemplateLibrary } from './TemplateLibrary';
import { useState } from 'react';
import type { LibraryTemplate } from '../../shared/templates';

export function PublishCenter({accounts,request,visible=true,onManageAccounts}:{accounts:Account[];request:(path:string,body?:unknown)=>Promise<any>;visible?:boolean;onManageAccounts?:()=>void}){
  const [tab,setTab]=useState<'create'|'library'>('create');
  const [templates,setTemplates]=useState<LibraryTemplate[]>([]);
  return <div className="publish-center"><div className="publish-tabs" role="tablist" aria-label="发布中心视图"><button role="tab" aria-selected={tab==='create'} onClick={()=>setTab('create')}>图文创作</button><button role="tab" aria-selected={tab==='library'} onClick={()=>setTab('library')}>模板素材库</button></div><div hidden={tab!=='library'}>{<TemplateLibrary request={request} onUse={items=>{setTemplates(items);setTab('create');}}/>}</div><div hidden={tab!=='create'}><OneClickPublish onManageAccounts={onManageAccounts} visible={visible&&tab==='create'} accounts={accounts} request={request} templates={templates} onClearTemplates={()=>setTemplates([])} onChooseTemplates={()=>setTab('library')}/></div></div>;
}

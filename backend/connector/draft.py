"""Guarded image draft execution. Upload/save are never retried after uncertainty."""
from __future__ import annotations
import asyncio
import base64
import json
import re
import shutil
import tempfile
import time
from datetime import datetime,timezone
from pathlib import Path
import httpx
from . import expressions as dom
from .browser import CREATOR,until,verify_editor,verify_persisted_draft,profile_lock
from .files import atomic_json,read_json,fingerprint
from .media import download_images
from .safety import ResultUnknown,safe_execution_error

def should_fallback_native(error):
    text=str(error).lower()
    if re.search(r'timeout|timed out|超时|unknown outcome|result unknown|result_unknown|command_lost|connection|disconnected|chooser|deadline',text):return False
    return bool(re.search(r'not supported|unsupported|unknown (action|method)|method.*(not found|wasn.t found)|wasn.t found|not allowed|cdp method not permitted: dom\.setfileinputfiles',text))

async def upload_with_preview(native,fallback,read,*,expected,on_phase=None):
    error=None; transport='cdp'
    if on_phase:await on_phase('upload','正在上传原始图片')
    try:await native()
    except Exception as exc:error=exc
    if error and not should_fallback_native(error):raise error
    if on_phase:await on_phase('preview','正在核对小红书图片预览')
    actual=await read(0 if error else 5)
    ready=lambda v:v and v.get('editor') and v.get('imageCount')==expected
    if not ready(actual):
        if error:
            if not actual:raise ValueError('无法确认原生上传后的页面状态，已停止重复传图')
            if actual.get('editor') or actual.get('imageCount') or actual.get('pendingImageCount'):raise ValueError('页面已有部分内容，已停止重复传图，请检查当前创作页')
            transport='data-transfer'
            if on_phase:await on_phase('upload','浏览器不支持直接上传，正在兼容传图')
            await fallback()
        actual=await read(15)
    if not ready(actual):raise ResultUnknown('图片预览未完成；保留现有页面，未重复上传')
    return dict(actual=actual,transport=transport)

READ_ACCOUNT = r"""(()=>document.querySelector('#header-area, .header-area, header, [class*=header-area]')?.innerText?.split('\n').map(s=>s.trim()).filter(s=>s&&s!=='创作服务平台').join(' ')||'')()"""

class DraftExecutor:
    def __init__(self,root:Path,runtime,*,client=None):
        self.root=Path(root); self.runtime=runtime; self.client=client
    async def __call__(self,input,progress):
        task_id=input['taskId']; base=input['apiBase']; token=input['token']; profile=input['profile']; run_id=input['runId']; started=input['startedAt']
        directory=self.root.parent/'studio-executions'; directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        evidence_path=directory/(task_id+'.json'); run_path=directory/(task_id+'-'+run_id+'.json'); manifest_path=directory/(task_id+'.approved.json')
        previous=read_json(evidence_path,{})
        evidence=dict(taskId=task_id,runId=run_id,startedAt=started,timing={},events=[],uploadAttempted=bool(previous.get('uploadAttempted') and previous.get('status')!='filled'))
        client=self.client or httpx.AsyncClient(follow_redirects=False,timeout=15,trust_env=False); own=self.client is None
        connection=None; download_dir=None; claimed=False; task=None; revision=None; stage='page'; start=time.monotonic()
        def save():atomic_json(evidence_path,evidence); atomic_json(run_path,evidence)
        async def api(path,body=None):
            headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}
            response=await client.request('POST' if body is not None else 'GET',base+'/api/'+path,json=body,headers=headers,follow_redirects=False,timeout=15)
            if 'application/json' not in response.headers.get('content-type',''):raise ValueError('工作台执行接口未就绪，请检查服务版本')
            value=response.json()
            if not response.is_success:raise ValueError(value.get('message',f'HTTP {response.status_code}'))
            return value
        async def phase(next_stage,message):
            nonlocal stage,revision
            stage=next_stage
            if connection:await connection.check(); await connection.pace(); await connection.check()
            evidence['events'].append(dict(stage=stage,elapsedMs=round((time.monotonic()-start)*1000),message=message)); save()
            await progress(dict(stage=stage,message=message,uploadAttempted=evidence['uploadAttempted']))
            if claimed:
                updated=await api(f'studio/{task_id}/progress',dict(revision=revision,message=message)); revision=updated['revision']
        try:
            task=await api('studio/'+task_id)
            if task.get('status')!='approved':raise ValueError('任务尚未审核通过')
            if not isinstance(task.get('images'),list) or not 1<=len(task['images'])<=12:raise ValueError('审核稿图片数量必须为 1–12 张')
            claim=await api(f'studio/{task_id}/claim',dict(revision=task['revision'],profile=profile,runId=run_id)); claimed=True; revision=claim['revision']
            async with profile_lock(self.root.parent/'studio-locks',profile,task_id):
                await phase('page','正在连接当前 Chrome 并核对账号')
                operations=await api('operations'); target=next((a for a in operations.get('accounts',[]) if a.get('id')==task.get('accountId')),None)
                if not target or target.get('profile')!=profile:raise ValueError('目标账号未绑定到当前执行设备')
                connection=await self.runtime.connect(profile,guard=True)
                info=await self.runtime.state(profile[6:])
                if not info.get('loggedIn') or str(info.get('handle'))!=str(target.get('handle')):raise ValueError('本机实际账号与任务目标不一致，请先扫码连接此账号')
                evidence['handle']=info['handle']
                # Reuse only an empty composer; existing user work stays in its tab.
                candidates=[p for p in connection.context.pages if p.url.startswith(CREATOR+'/publish/publish')]
                selected=None
                for page in candidates[:5]:
                    await connection.select(page); await connection.foreground()
                    actual=await connection.evaluate(dom.expression(dom.READEDITOR))
                    if not any(actual.get(k) for k in ('editor','imageCount','pendingImageCount','title','text')) and 'target=image' in page.url:selected=page; break
                if selected is None:selected=await connection.new_page(CREATOR+'/publish/publish?from=menu_left&target=image')
                await connection.select(selected); await connection.foreground()
                async def ready():
                    try:return await connection.evaluate('(()=>({name:'+READ_ACCOUNT+',...('+dom.READEDITOR+')(),visible:!document.hidden,input:!!document.querySelector(\'input[type="file"][multiple][accept*=".jpg"]\')}))()')
                    except Exception:return None
                actual=await until(ready,lambda v:v and v.get('visible') and v.get('name') and (v.get('input') or v.get('editor')),45)
                if not actual or not actual.get('visible') or not actual.get('name'):raise ValueError('Chrome 创作页尚未就绪或未切到前台，已停止上传')
                name=actual['name']; evidence['account']=name; evidence['initialPage']=actual
                if name.strip().lower()!=str(target.get('name','')).strip().lower():raise ValueError('浏览器当前账号名称与审核稿目标不一致')
                if actual.get('editor') or actual.get('imageCount') or actual.get('pendingImageCount'):raise ValueError('当前创作页已有未保存内容，已保留原页面')
                if not actual.get('input'):raise ValueError('当前页面缺少图片上传控件')
                manifest=read_json(manifest_path); stamp=fingerprint(dict(profile=profile,title=task['title'],body=task['body'],tags=task['tags'],images=task['images']))
                stored=await connection.evaluate(dom.expression(dom.READPERSISTEDIMAGEDRAFT,task['title']))
                if stored.get('matches'):
                    if not manifest or manifest.get('fingerprint')!=stamp:raise ValueError('已有同名草稿缺少本次审核的图片回读凭据，请检查现有草稿，不会重复上传')
                    readback=verify_persisted_draft(stored,task,manifest.get('fileIds'),True)
                    if not readback:raise ValueError('已有同名草稿无法唯一确认，已停止重复上传')
                    visible=await self.confirm_visible(connection,task['title'])
                    if not visible.get('drawer') or visible.get('matches')!=1 or readback['draftId'] not in visible.get('draftIds',[]):raise ValueError('草稿已存储，但平台列表未能显示，请人工核对')
                    evidence.update(persisted=readback,draft={**visible,'saved':True,'recovered':True},readback=readback)
                else:
                    if previous.get('uploadAttempted') and previous.get('status')!='filled':raise ResultUnknown('上次上传结果尚未确认，已保留原稿，禁止重复上传；请人工核对原电脑草稿')
                    await self.inspect_before_upload(connection,task['title'])
                    await phase('download','正在下载审核稿原始图片')
                    prefix=base+'/api/studio/'+task_id+'/media/'
                    urls=[prefix+url.rsplit('/',1)[-1] if re.fullmatch(r'/api/templates/media/[a-f0-9]{64}\.(png|jpg|webp)',url) else url for url in task['images']]
                    cache=self.root/'generated-cache'; cache.mkdir(parents=True,exist_ok=True,mode=0o700); download_dir=Path(tempfile.mkdtemp(prefix='draft-',dir=cache))
                    files=await download_images(urls,download_dir,client=client,allowed_prefix=prefix,token=token)
                    evidence['files']=[{k:f[k] for k in ('name','mime','bytes')} for f in files]
                    async def native():
                        evidence['uploadAttempted']=True; save(); await progress(dict(uploadAttempted=True))
                        await connection.cdp('DOM.enable'); result=await connection.cdp('DOM.getDocument',dict(depth=0))
                        nodes=await connection.cdp('DOM.querySelectorAll',dict(nodeId=result['root']['nodeId'],selector='input[type="file"][multiple][accept*=".jpg"]'))
                        if len(nodes.get('nodeIds',[]))!=1:raise ValueError('图片上传控件数量异常')
                        await connection.cdp('DOM.setFileInputFiles',dict(files=[f['path'] for f in files],nodeId=nodes['nodeIds'][0]))
                    async def fallback():
                        payload=[dict(name=f['name'],mime=f['mime'],data=base64.b64encode(Path(f['path']).read_bytes()).decode()) for f in files]
                        source=r"""items=>{const input=[...document.querySelectorAll('input[type="file"][multiple]')].find(e=>/\.jpg|\.jpeg|\.png|\.webp/i.test(e.accept));if(!input)throw Error('未找到图片上传控件');const dt=new DataTransfer();for(const item of items){const bytes=Uint8Array.from(atob(item.data),c=>c.charCodeAt(0));dt.items.add(new File([bytes],item.name,{type:item.mime}));}input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return {submitted:items.length};}"""
                        await connection.evaluate(dom.expression(source,payload))
                    async def read(timeout):return await until(lambda:connection.evaluate(dom.expression(dom.READEDITOR)),lambda v:v.get('editor') and v.get('imageCount')==len(task['images']),timeout)
                    upload=await upload_with_preview(native,fallback,read,expected=len(task['images']),on_phase=phase); evidence['transport']=upload['transport']
                    await phase('fill','图片已就绪，正在填充并回读标题、正文和标签')
                    await connection.evaluate(dom.expression(dom.FILLEDITOR,dict(title=task['title'],body=task['body'],tags=[])))
                    evidence['topics']=await self.fill_topics(connection,task['tags'])
                    await connection.evaluate("(()=>{const title=document.querySelector('#web input[placeholder*=\"标题\"]');title.focus();title.select();return true;})()")
                    await connection.insert_text(task['title'])
                    if not await until(lambda:connection.evaluate(dom.expression(dom.READTITLEPREVIEW,task['title'])),bool,5):raise ValueError('标题尚未同步到小红书预览，未保存空标题草稿')
                    readback=verify_editor(await connection.evaluate(dom.expression(dom.READEDITOR)),task); evidence['readback']=readback
                    file_ids=await connection.evaluate(dom.expression(dom.UPLOADEDDRAFTFILEIDS)); manifest=dict(fingerprint=stamp,fileIds=file_ids); atomic_json(manifest_path,manifest)
                    await phase('save','内容回读一致，正在保存并核对草稿箱')
                    before=await connection.evaluate(dom.expression(dom.READPERSISTEDIMAGEDRAFT,task['title']))
                    if before.get('matches') and not verify_persisted_draft(before,task,file_ids,True):raise ValueError('草稿箱已有同名内容，已停止重复保存')
                    await self.click_save(connection) # exactly one visible draft action
                    persisted=await until(lambda:connection.evaluate(dom.expression(dom.READPERSISTEDIMAGEDRAFT,task['title'])),lambda v:v.get('available') and v.get('matches')==1,12)
                    proof=verify_persisted_draft(persisted,task,file_ids,True)
                    if not proof:raise ResultUnknown('未确认草稿持久化内容，请人工核对，勿重复上传')
                    if (await connection.evaluate(dom.expression(dom.READEDITOR))).get('editor'):await connection.new_page(CREATOR+'/publish/publish?target=image')
                    visible=await self.confirm_visible(connection,task['title'])
                    if not visible.get('drawer') or visible.get('matches')!=1 or proof['draftId'] not in visible.get('draftIds',[]):raise ResultUnknown('未得到草稿箱唯一条目确认；请人工核对，勿重复上传')
                    evidence.update(persisted=proof,draft={**visible,'saved':True,'persisted':persisted})
                if await connection.evaluate(READ_ACCOUNT)!=name or not connection.page.url.startswith(CREATOR+'/publish/publish'):raise ResultUnknown('保存后账号或创作页发生变化，请检查草稿箱')
                receipt=await api(f'studio/{task_id}/receipt',dict(revision=revision,status='filled',accountId=task['accountId'],title=readback['title'],body=readback['body'],tags=readback['tags'],imageCount=readback['imageCount'],runId=run_id,draftId=evidence['persisted'].get('draftId'),message='已核对账号、图片、正文和平台草稿箱唯一条目。草稿位于执行电脑专属浏览器，请检查后由人工点击发布。'))
                evidence.update(status='filled',finishedAt=datetime.now(timezone.utc).isoformat(),executionElapsedMs=receipt.get('executionElapsedMs')); return evidence
        except BaseException as exc:
            evidence.update(status='blocked',error=safe_execution_error(exc),stage=stage,retrySafe=not evidence['uploadAttempted'] and stage in ('page','download'))
            if claimed and not isinstance(exc,asyncio.CancelledError):
                try:
                    current=await api('studio/'+task_id)
                    if current.get('status')=='filling':await api(f'studio/{task_id}/receipt',dict(revision=current['revision'],status='blocked',message=evidence['error'],runId=run_id,retrySafe=evidence['retrySafe']))
                except Exception:pass
            raise
        finally:
            evidence['timing']['total']=round((time.monotonic()-start)*1000); save()
            if connection:await connection.close()
            if download_dir:
                # Only the execution's created cache directory is removed.
                if download_dir.resolve().is_relative_to((self.root/'generated-cache').resolve()):shutil.rmtree(download_dir)
            if own:await client.aclose()
    async def inspect_before_upload(self,connection,title):
        await connection.evaluate(dom.expression(dom.REFRESHPLATFORMDRAFTLIST))
        stored=await connection.evaluate(dom.expression(dom.READPERSISTEDIMAGEDRAFT,title))
        if stored.get('matches'):raise ValueError('草稿箱已有同名内容，已停止重复上传')
        async def read():
            await connection.evaluate(dom.expression(dom.OPENIMAGEDRAFTS)); return await connection.evaluate(dom.expression(dom.INSPECTDRAFTLIST,title))
        visible=await until(read,lambda v:v.get('drawer'),5)
        if not visible.get('drawer'):raise ValueError('未能检查图文草稿箱，已停止重复上传')
        if visible.get('matches'):raise ValueError('草稿箱已有同名内容，已停止重复上传')
        await connection.evaluate("document.querySelector('.draft-drawer .d-drawer-close')?.click()")
    async def confirm_visible(self,connection,title):
        await connection.evaluate(dom.expression(dom.REFRESHPLATFORMDRAFTLIST))
        async def read():
            await connection.evaluate(dom.expression(dom.OPENIMAGEDRAFTS)); return await connection.evaluate(dom.expression(dom.INSPECTDRAFTLIST,title))
        return await until(read,lambda v:v.get('drawer') and v.get('matches')==1,6)
    async def click_save(self,connection):
        result=await connection.cdp('Accessibility.getFullAXTree')
        buttons=[n for n in result.get('nodes',[]) if not n.get('ignored') and n.get('role',{}).get('value')=='button' and n.get('name',{}).get('value') in ('暂存离开','存草稿','保存草稿') and n.get('backendDOMNodeId') and not any(p.get('name')=='disabled' and p.get('value',{}).get('value') is True for p in n.get('properties',[]))]
        if len(buttons)!=1:raise ValueError('暂存按钮不可用或不唯一')
        box=await connection.cdp('DOM.getBoxModel',dict(backendNodeId=buttons[0]['backendDOMNodeId'])); q=box.get('model',{}).get('content')
        if not isinstance(q,list) or len(q)!=8 or any(not isinstance(x,(int,float)) for x in q) or q[2]<=q[0] or q[5]<=q[1]:raise ValueError('暂存按钮没有可点击区域')
        await connection.native_click(sum(q[::2])/4,sum(q[1::2])/4)
    async def fill_topics(self,connection,tags):
        if not tags:return []
        await connection.evaluate("(()=>{const b=document.querySelector('#web [contenteditable=true]');if(!b)throw Error('未找到正文');b.focus();const r=document.createRange();r.selectNodeContents(b.lastElementChild||b);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event('selectionchange'));return true;})()")
        await asyncio.sleep(.1); await connection.evaluate("document.execCommand('insertParagraph')")
        selected=[]
        for name in tags:
            await connection.insert_text('#'); await connection.insert_text(name)
            candidate=await until(lambda:connection.evaluate(dom.expression(dom.FINDTOPICCANDIDATE,name)),bool,8,.2)
            if not candidate:raise ValueError(f'未找到小红书话题「{name}」的同名候选，尚未确认保存成功')
            await connection.native_click(candidate['x'],candidate['y'])
            actual=await until(lambda:connection.evaluate(dom.expression(dom.READNATIVETOPICS)),lambda v:any(t.get('name')==name and t.get('id')==candidate['id'] for t in v),3,.1)
            if not any(t.get('name')==name and t.get('id')==candidate['id'] for t in actual):raise ValueError(f'话题「{name}」未形成平台话题链接，已停止保存')
            selected.append(dict(name=name,id=candidate['id']))
        return selected

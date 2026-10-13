import { executionToken } from './execution-access';
import { randomUUID } from 'node:crypto';
import type { createStudio } from './studio';
import type { Studio } from './postgres-tasks';
const cancelers=new Map<string,()=>Promise<any>>();
export async function cancelStudioExecution(id:string){const cancel=cancelers.get(id);if(!cancel)return {stopConfirmed:false,message:'停止尚未确认，请核对原执行电脑'};return cancel();}
const running = new Map<string, ReturnType<typeof setTimeout> | null>();
export const isStudioExecutorRunning = (id: string) => running.has(id);
export function finishStudioExecution(id: string) { const timer = running.get(id); if (timer)
    clearTimeout(timer); running.delete(id);cancelers.delete(id); }
export async function recoverStalledExecutions(studio: Studio, now = Date.now()) {
    for (const task of (await studio.list())) {
        if (!['approved', 'filling'].includes(task.status)) {
            finishStudioExecution(task.id);
            continue;
        }
        if ((task.status === 'filling' || task.executionStartedAt) && !running.has(task.id) && now - Date.parse(task.updatedAt) > 15 * 60 * 1000) {
            try {
                (await studio.update(task.id, task.revision, { status: 'blocked', message: '草稿结果待核对，请在原执行电脑检查草稿。禁止重复上传或换电脑重试。' }));
            }
            catch { }
        }
    }
}
export async function launchStudioExecutor(studio: Studio, id: string, profile?: string, transport?: {
    send: (path: string, body?: unknown) => Promise<any>;
    callback: string;
    token?: string;
}) {
    if (running.has(id))
        return;
    if (!profile?.startsWith('local:'))
        throw Error('该账号尚未完成连接，请先在账号矩阵中扫码登录');
    const connector = process.env.LOCAL_CONNECTOR_URL?.replace(/\/$/, '');
    const callback = transport?.callback || process.env.STUDIO_CALLBACK_URL || process.env.PUBLIC_ORIGIN;
    const token = transport?.token || executionToken();
    if (!transport && (!connector || !process.env.LOCAL_CONNECTOR_TOKEN))
        throw Error('执行设备尚未配对');
    if (!callback || !token)
        throw Error('执行设备回传地址未配置，请联系管理员');
    const get = studio.get, update = studio.update; // Capture the authenticated workspace before async work.
    const runId = randomUUID(), started = Date.now();
    const before = await get(id);
    await update(id,before.revision,{executionRunId:runId});
    running.set(id, null);
    const fail = async (message: string) => { await cancelers.get(id)?.().catch(()=>{});finishStudioExecution(id); try {
        const t = (await get(id));
        if (['approved', 'filling'].includes(t.status))
            (await update(id, t.revision, { status: 'blocked', message }));
    }
    catch { } };
    const send = transport?.send ?? (async (path: string, body?: unknown) => {
        const r = await fetch(connector + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + process.env.LOCAL_CONNECTOR_TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
        const result = await r.json();
        if (!r.ok)
            throw Error(result.message || `执行设备 HTTP ${r.status}`);
        return result;
    });
    cancelers.set(id,async()=>{try{const state=await send('/studio/'+runId+'/cancel',{});return {stopConfirmed:state.stopConfirmed===true,message:state.stopConfirmed?'停止已确认':'停止尚未确认，请核对原执行电脑'};}catch{return {stopConfirmed:false,message:'停止尚未确认，原执行电脑离线；租约到期后停止后续步骤'};}});
    const schedule = () => { if (!running.has(id))
        return; const timer = setTimeout(() => void monitor(), 2000); timer.unref(); running.set(id, timer); };
    let failures = 0;
    const monitor = async () => {
        if (!running.has(id))
            return;
        try {
            const task = (await get(id));
            if (!['approved', 'filling'].includes(task.status)) {
                finishStudioExecution(id);
                return;
            }
            if (Date.now() - started > 12 * 60 * 1000) {
                (await fail('执行设备处理超时，未确认草稿保存。请在原电脑核对平台草稿，勿重复上传。'));
                return;
            }
            const state = await send('/studio/' + runId);
            failures = 0;
            if (state.status === 'blocked') {
                (await fail(state.message || '执行设备未能完成草稿保存'));
                return;
            }
            if (state.status === 'complete') {
                const current = (await get(id));
                if (current.status !== 'filled')
                    (await fail('设备已结束但云端未收到保存回执，请在原电脑核对现有草稿，勿重复上传'));
                else
                    finishStudioExecution(id);
                return;
            }
        }
        catch {
            if (++failures >= 3) {
                (await fail('执行设备连接中断，未确认草稿保存。请恢复原执行电脑连接并核对草稿，勿重复上传。'));
                return;
            }
        }
        schedule();
    };
    void send('/studio', { taskId: id, runId, apiBase: callback, token, profile, startedAt: (await get(id)).executionStartedAt || new Date().toISOString() }).then(() => {
        // Only the executor's atomic /claim may change approved -> filling. A dispatch
        // acknowledgement must not alter the revision or race a progress/receipt callback.
        schedule();
    }).catch(async () => (await fail('执行设备未接受任务，请检查连接器版本和配对通道后重试。')));
}

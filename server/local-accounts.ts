import type {BrowserRuns} from './browser-runs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import type { BusinessStore as Store } from './postgres-store';
import {serial} from './serial';
import type { createLocalConnector } from './local-connector';
export function createLocalAccounts(dir: string, store: Store, connector: Omit<ReturnType<typeof createLocalConnector>, 'login'> & {login:(id:string, deviceId?:string)=>Promise<any>},browserRuns?:BrowserRuns) {
    const root = join(dir, 'local-logins');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    type Job = {
        id: string;
        sessionId: string;
        accountId?: string;
        expectedHandle?: string;
        deviceId?: string;
        deviceName?: string;
        status: string;
        stopConfirmed?:boolean;
        stage?: string;
        message: string;
        createdAt: string;
    };
    const path = (id: string) => { if (!/^[a-f0-9-]{36}$/.test(id))
        throw Error('无效扫码任务'); return join(root, id + '.json'); };
    const save = (job: Job) => { const file = path(job.id); writeFileSync(file + '.tmp', JSON.stringify(job), { mode: 0o600 }); renameSync(file + '.tmp', file); return job; };
    const terminal = (job: Job) => ['cancelled', 'failed', 'authenticated'].includes(job.status);
    const expire = (job: Job) => { if (!terminal(job) && (!Number.isFinite(Date.parse(job.createdAt)) || Date.now() - Date.parse(job.createdAt) > 15 * 60 * 1000))
        return save({ ...job, status: 'failed', message: '扫码任务已过期，请重新发起扫码' }); return job; };
    const list = () => readdirSync(root).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).flatMap(f => { try {
        return [expire(JSON.parse(readFileSync(join(root, f), 'utf8')) as Job)];
    }
    catch {
        return [];
    } }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const read = (id: string): Job => { if (!existsSync(path(id)))
        throw Error('扫码任务不属于当前工作区'); return JSON.parse(readFileSync(path(id), 'utf8')); };
    const start = async (accountId?: string, deviceId?: string, deviceName?: string) => {
        const account = accountId ? (await store.listAccounts()).find(a => a.id === accountId) : undefined;
        if (accountId && !account)
            throw Error('目标账号不存在');
        if(account)browserRuns?.assertAvailable(account.handle);
        const activeJobs = list().filter(j => !terminal(j));
        const active = activeJobs.find(j => j.deviceId === deviceId);
        if (active) {
            if (active.accountId !== accountId || active.deviceId !== deviceId)
                throw Error('请先完成或取消当前扫码任务');
            return active;
        }
        // A fresh login on a new computer supersedes this account's unfinished
        // attempt. Late polls from the old computer cannot change its binding.
        if (accountId) for (const previous of activeJobs.filter(j => j.accountId === accountId))
            save({...previous,status:'cancelled',message:'已在另一台电脑重新发起登录，此次扫码已取消'});
        const id = randomUUID();
        // A re-scan is a new login on the currently selected computer. Reusing
        // the old profile sends the login command to its old device forever,
        // even after the customer selects a new computer. Keep the old binding
        // intact until both identities on this new session are verified.
        const sessionId = createHash('sha256').update(dir + ':' + id).digest('hex').slice(0, 48);
        const job: Job = { id, sessionId, accountId, expectedHandle: account?.handle, deviceId, deviceName, status: 'starting', message: '正在打开账号专属登录窗口', createdAt: new Date().toISOString() };
        save(job);
        try {
            await connector.login(sessionId, deviceId);
            job.status = 'waiting_scan';
            job.message = `${deviceName ? `已在“${deviceName}”打开浏览器登录窗口。` : ''}${account ? `请在弹出的浏览器中扫码登录 ${account.name}（${account.handle}）` : '请在弹出的浏览器中使用小红书 App 扫码'}`;
        }
        catch (e) {
            job.status = 'failed';
            job.message = e instanceof Error ? e.message : '连接器启动失败';
        }
        const current = expire(read(job.id));
        if (terminal(current))
            return current;
        save(job);
        return job;
    };
    const status = async (id: string) => {
        let job = expire(read(id));
        if (['cancelled', 'failed'].includes(job.status))
            return job;
        if (job.status === 'authenticated')
            return { ...job, account: (await store.listAccounts()).find(a => a.id === job.accountId), accountWritten: false };
        const info = await connector.state(job.sessionId);
        // Re-read after I/O: cancellation, deletion or another poll may have won.
        job = expire(read(id));
        if (terminal(job))
            return job;
        if (job.accountId && !(await store.listAccounts()).some(a => a.id === job.accountId))
            return save({ ...job, status: 'cancelled', message: '目标账号已删除，扫码已取消' });
        const waiting = (stage: string, message: string) => save({ ...job, status: 'waiting_scan', stage, message });
        const creatorLoggedIn = info.creatorLoggedIn === true;
        const webLoggedIn = info.webLoggedIn === true;
        const handle = String(info.handle ?? info.creatorHandle ?? '').trim();
        const webHandle = String(info.webHandle ?? '').trim();
        if (!creatorLoggedIn) {
            return waiting(job.stage ?? 'creator', job.stage === 'web' ? '正在重新确认创作平台登录状态，请保持弹出的浏览器页面打开' : '第 1 步：请在弹出的浏览器中扫码登录创作服务平台');
        }
        if (!webLoggedIn) {
            return waiting('web', info.web?.status === 'unknown' ? '网页版登录状态暂时无法确认，请检查网络或页面提示；系统不会自动刷新登录页面' : '第 2 步：创作平台已登录，已打开小红书网页版，请在浏览器中继续扫码');
        }
        if (info.stage === 'mismatch' || (handle && webHandle && handle.toLowerCase() !== webHandle.toLowerCase())) {
            job.status = 'failed';
            job.message = `创作平台账号 ${handle || '未知'} 与网页版账号 ${webHandle || '未知'} 不一致，未修改绑定`;
            save(job);
            return job;
        }
        if (!handle || !webHandle) {
            return waiting(job.stage ?? 'web', '尚未取得两个平台的账号编号，暂不绑定，请保持账号首页打开');
        }
        if (job.expectedHandle && handle.toLowerCase() !== job.expectedHandle.toLowerCase()) {
            job.status = 'failed';
            job.message = `扫码账号 ${handle} 与目标 ${job.expectedHandle} 不一致，未修改绑定`;
            save(job);
            return job;
        }
        const name = String(info.name ?? info.creator?.name ?? info.web?.name ?? '').trim();
        if (!name) {
            return waiting(job.stage ?? 'web', '已登录，正在读取账号名称，请保持创作平台首页打开');
        }
        const existing = (await store.listAccounts()).find(a => a.handle.toLowerCase() === handle.toLowerCase());
        browserRuns?.assertAvailable(handle);
        const account = { ...(existing ?? {}), id: existing?.id ?? `xhs-${handle}`, name, handle, profile: 'local:' + job.sessionId, avatar: existing?.avatar ?? '', followers: info.followers ?? info.creator?.followers ?? existing?.followers ?? 0, lastSyncedAt: existing?.lastSyncedAt ?? '', state: 'connected' as const };
        // Only a verified new login may create an account. Ordinary sync imports
        // must never recreate a deleted account from a late callback.
        if(!existing)await store.addAccount(account);
        // Upsert changes a verified existing binding; addAccount intentionally does not.
        (await store.importSnapshot({ account, notes: [], comments: [] }));
        job.accountId = account.id;
        job.status = 'authenticated';
        job.stage = 'ready';
        job.message = `已绑定 ${account.name}（${account.handle}），可以同步草稿和读取内容`;
        save(job);
        return { ...job, account, accountWritten: true };
    };
    const remove = async (accountId: string) => {
        const account = (await store.listAccounts()).find(a => a.id === accountId);
        if (!account)
            throw Error('账号不存在');
        const sessionId = account.profile.startsWith('local:') ? account.profile.slice(6) : '';
        const result = (await store.deleteAccount(accountId));
        // Once the account row is gone, late execution callbacks cannot pass
        // the binding checks or recreate it. Drop the old account lease so a
        // deliberate re-add of the same handle can start a fresh session.
        browserRuns?.releaseAccount(account.handle);
        if (sessionId) {
            try {
                await connector.remove(sessionId);
            }
            catch { /* account data is already removed; stale session cleanup is best effort */ }
        }
        for (const file of readdirSync(root)) {
            if (!file.endsWith('.json'))
                continue;
            try {
                const job = JSON.parse(readFileSync(join(root, file), 'utf8')) as Job;
                if (job.accountId === accountId && !terminal(job))
                    save({ ...job, status: 'cancelled', message: '账号已删除，扫码已取消' });
            }
            catch { /* ignore unrelated malformed history */ }
        }
        return result;
    };
    return { start:(accountId?:string,deviceId?:string,deviceName?:string)=>serial(dir+':login-start',()=>start(accountId,deviceId,deviceName)), status:(id:string)=>serial(dir+':login-status:'+id,()=>status(id)), remove,
        adopt: async (id: string) => { const job = read(id); if (job.status !== 'failed' || !job.message.includes('与目标'))
            throw Error('此任务不能更换接入目标，请重新扫码'); delete job.expectedHandle; delete job.accountId; job.status = 'waiting_scan'; save(job); return status(id); },
        latest: (deviceId?:string) => list().find(j => !deviceId || j.deviceId === deviceId) ?? null,
        image: async (id: string) => { const job = expire(read(id)); if (terminal(job))
            throw Error('扫码任务已结束，请重新发起扫码'); const image = await connector.image(job.sessionId); if (terminal(expire(read(id))))
            throw Error('扫码任务已结束'); return image; },
        cancel: async (id: string) => { const job = read(id); if (terminal(job))
            return job;save({...job,status:'cancelled',stopConfirmed:false,message:'已申请取消，停止尚未确认'});try{const stopped=await connector.cancel?.(job.sessionId);return save({...job,status:'cancelled',stopConfirmed:stopped?.stopConfirmed===true,message:stopped?.stopConfirmed?'扫码已取消':'停止尚未确认，请核对原执行电脑'});}catch{return save({...job,status:'cancelled',stopConfirmed:false,message:'停止尚未确认，请核对原执行电脑'});} }
    };
}

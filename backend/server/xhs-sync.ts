import { join } from 'node:path';
import type {BrowserRuns} from './browser-runs';
import { executionToken } from './execution-access';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { scriptPath } from './runtime-paths.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { BusinessStore as Store } from './postgres-store';
import type {createPostgresJobs} from './postgres-jobs';
import {serial} from './serial';
export type XhsSyncStage = 'starting' | 'queued' | 'account' | 'notes' | 'comments' | 'messages' | 'media' | 'saving' | 'finished' | 'blocked';
export type XhsSyncJob = {
    id: string;
    accountId: string;
    profile: string;
    status: 'running' | 'partial' | 'complete' | 'blocked';
    stage: XhsSyncStage;
    message: string;
    counts: {
        notes: number;
        comments: number;
        messages: number;
    };
    startedAt: string;
    finishedAt?: string;
    error?: string;
    queuePosition?: number | null;
    stopConfirmed?: boolean;
    source?: 'event';
    eventDeviceId?: string;
};
export type XhsSyncOptions = { mode?: 'incremental'; source?: 'event'; eventKinds?: Array<'notes'|'comments'|'messages'>; eventDeviceId?:string; expectedHandle?:string };
export function recentSyncIds(items:Array<{id:string;createdAt?:string;publishedAt?:string}>,field:'createdAt'|'publishedAt'='createdAt'){
    return [...items].sort((a,b)=>String(b[field]??'').localeCompare(String(a[field]??''))||a.id.localeCompare(b.id)).slice(0,10000).map(x=>x.id);
}
export function writeSyncBaseline(root:string,id:string,accountId:string,knownComments:string[],knownMessages:string[]){
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)||[knownComments,knownMessages].some(ids=>ids.length>10000||ids.some(x=>typeof x!=='string'||!x||x.length>256)))throw Error('同步基线参数无效');
    const file=join(root,id+'.baseline.json');
    writeFileSync(file,JSON.stringify({jobId:id,accountId,knownComments,knownMessages}),{mode:0o600,flag:'wx'});return file;
}
export function createXhsSync(dir: string, store: Store, remote?: (profile: string,options?:XhsSyncOptions) => Promise<{
    url: string;
    token: string;
} | undefined>, durable?:ReturnType<typeof createPostgresJobs>,browserRuns?:BrowserRuns) {
    const root = join(dir, 'xhs-sync');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // The worker reads this file while the parent may finish a failed child.
    // Replace it atomically so the worker never observes a truncated JSON file.
    const writeState = (path: string, value: unknown) => {
        const temporary = path + '.server-tmp-' + process.pid + '-' + randomUUID();
        writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
        renameSync(temporary, path);
    };
    const jobs = new Map<string, {
        statePath: string;
        child: ReturnType<typeof spawn>;
    }>();
    const readFile = (id: string): XhsSyncJob | null => { if (!/^[a-f0-9-]{36}$/.test(id))
        return null; const p = join(root, id + '.json'); if (!existsSync(p))
        return null; try {
        return JSON.parse(readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    } };
    for (const file of readdirSync(root).filter(f => /^[a-f0-9-]{36}\.json$/.test(f))) {
        const job = readFile(file.slice(0, -5));
        if (job?.status === 'running') {
            writeFileSync(join(root, file), JSON.stringify({ ...job, status: 'blocked', stage: 'blocked', message: '服务重启中断了同步，已保存内容保留，请重新同步', finishedAt: new Date().toISOString() }), { mode: 0o600 });
            // Sync only reads and idempotently upserts collected content. Once
            // the persisted receipt is marked as interrupted, this server can
            // safely let the account retry; the old in-process lease is stale.
            if(job.source!=='event')browserRuns?.release(job.id);
        }
    }
    // Previous-process baselines contain only input IDs. Once its job has a
    // terminal/interrupted receipt they are not needed for recovery or audit.
    for(const file of readdirSync(root).filter(f=>/^[a-f0-9-]{36}\.baseline\.json$/.test(f))){
        if(readFile(file.slice(0,-14))?.status!=='running')try{unlinkSync(join(root,file));}catch{}
    }
    const read = async(id:string)=>durable?durable.read(id):readFile(id);
    const terminalHandlers = new Set<(job:XhsSyncJob)=>void|Promise<void>>();
    const terminalReceipts = new Map<string,Promise<void>>();
    const notifyTerminal = (state:XhsSyncJob|null) => {
        if(!state||!['complete','partial','blocked'].includes(state.status))return Promise.resolve();
        const key=state.id+':'+state.status+':'+String(state.stopConfirmed);
        if(!terminalReceipts.has(key))terminalReceipts.set(key,Promise.resolve().then(async()=>{
            for(const handler of terminalHandlers)await handler(state);
        }).catch(()=>{terminalReceipts.delete(key);}));
        return terminalReceipts.get(key)!;
    };
    const observe = (state:XhsSyncJob|null) => {
        if(state&&(['complete','partial'].includes(state.status)||(state.status==='blocked'&&state.stopConfirmed===true)))browserRuns?.release(state.id);
        void notifyTerminal(state);
        return state;
    };
    const start = async (accountId: string, profile: string, cli?: string, options: XhsSyncOptions = {}) => {
        const account = (await store.listAccounts()).find(a => a.id === accountId);
        if (!account)
            throw Error('账号不存在');
        if (options.source==='event'&&(account.profile!==profile||account.handle!==options.expectedHandle))throw Error('事件的原账号绑定已改变');
        if (!profile)
            throw Error('当前工作区未配置浏览器 Profile，请先完成扫码登录');
        if (!profile.startsWith('local:'))
            throw Error('该账号尚未完成连接，请先扫码登录');
        for (const [jobId] of jobs) {
            const active = await read(jobId);
            if (active?.accountId === accountId && active.status === 'running')
                return active;
        }
        const remoteConfig = (await remote?.(profile,options));
        if(durable)await durable.latest(accountId);
        const id = randomUUID(), statePath = join(root, id + '.json');
        const knownComments = options.mode === 'incremental' ? recentSyncIds(await store.listComments({accountId})) : [];
        const knownMessages = options.mode === 'incremental' ? recentSyncIds(await store.listMessages({accountId})) : [];
        browserRuns?.claim(account.handle,id,profile);
        const state: XhsSyncJob = { id, accountId, profile, status: 'running', stage: 'starting', message: remoteConfig ? '正在连接客户执行电脑上的 Chrome…' : '正在连接当前执行电脑上的 Chrome…', counts: { notes: 0, comments: 0, messages: 0 }, startedAt: new Date().toISOString() };
        if(options.source==='event'){state.source='event';state.eventDeviceId=options.eventDeviceId;}
        if(durable){const created=await durable.create(state);if(!created.fresh){browserRuns?.release(id);return created.state;}}
        writeState(statePath, state);
        const baselinePath=writeSyncBaseline(root,id,accountId,knownComments,knownMessages);
        const script = scriptPath('scripts', 'xhs-sync.mjs');
        const childEnv:NodeJS.ProcessEnv={ ...process.env, ...(remoteConfig ? { LOCAL_CONNECTOR_URL: remoteConfig.url, LOCAL_CONNECTOR_TOKEN: remoteConfig.token } : {}), STUDIO_TOKEN: executionToken(), SYNC_API_BASE: process.env.STUDIO_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4174}`, SYNC_STATE_PATH: statePath, SYNC_DURABLE: durable?'1':'', SYNC_DATA_DIR: dir, SYNC_ACCOUNT_ID: accountId, SYNC_ACCOUNT_HANDLE: account.handle, SYNC_ACCOUNT_NAME: account.name, SYNC_PROFILE: profile, SYNC_MODE: options.mode ?? '', SYNC_SOURCE: options.source ?? '', SYNC_EVENT_KINDS: JSON.stringify(options.eventKinds ?? []), SYNC_BASELINE_PATH:baselinePath };
        delete childEnv.SYNC_KNOWN_COMMENTS;delete childEnv.SYNC_KNOWN_MESSAGES;
        const child = spawn(process.execPath, [script, id], { stdio: ['ignore', 'ignore', 'ignore'], env:childEnv });
        const deadline = setTimeout(() => { child.kill('SIGTERM'); void fail('本次同步等待与执行超过 18 分钟，已保存内容保留，请检查执行设备和账号登录后重试').catch(()=>{}); }, 18 * 60 * 1000);
        deadline.unref();
        jobs.set(id, { statePath, child });
        const fail = async(message:string)=>{clearTimeout(deadline);let current=await read(id);if(current?.status==='running'){const patch={status:'blocked' as const,stage:'blocked' as const,message,finishedAt:new Date().toISOString()};current=durable?await durable.update(id,patch):{...current,...patch};writeState(statePath,current);}observe(current);jobs.delete(id);try{unlinkSync(baselinePath);}catch{}};
        child.once('error', () => void fail('同步执行器无法启动').catch(()=>{}));
        child.once('exit', (code) => void fail(`同步执行器已退出（${code}），未确认读取完成`).catch(()=>{}));
        return state;
    };
    const latestFile=(accountId:string)=>readdirSync(root).filter(f=>/^[a-f0-9-]{36}\.json$/.test(f)).map(f=>readFile(f.slice(0,-5))).filter((s):s is XhsSyncJob=>!!s&&s.accountId===accountId).sort((a,b)=>b.startedAt.localeCompare(a.startedAt))[0]??null;
    const latest=durable?async(accountId:string)=>observe(await durable.latest(accountId)):(accountId:string)=>observe(latestFile(accountId));
    const running=(accountId:string)=>durable?durable.running(accountId):readdirSync(root).some(f=>/^[a-f0-9-]{36}\.json$/.test(f)&&readFile(f.slice(0,-5))?.accountId===accountId&&readFile(f.slice(0,-5))?.status==='running');
    const cancel=async(id:string)=>{
      const state=observe(await read(id));if(!state)return null;
      if(['complete','partial'].includes(state.status)||(state.status==='blocked'&&state.stopConfirmed===true))return state;
      let stopConfirmed=state.stopConfirmed===true;try{if(!stopConfirmed){const config=await remote?.(state.profile);if(config){
       const response=await fetch(config.url+'/sync/'+id+'/cancel',{method:'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});const result=await response.json();stopConfirmed=response.ok&&result.stopConfirmed===true;
      }}}catch{}
      jobs.get(id)?.child.kill('SIGTERM');
      const patch=state.status==='blocked'?{stopConfirmed,...(stopConfirmed?{message:'停止已确认'}:{})}:{status:'blocked' as const,stage:'blocked' as const,message:stopConfirmed?'停止已确认':'停止尚未确认，请保持原执行电脑在线；租约失效后停止后续步骤',stopConfirmed,finishedAt:new Date().toISOString()};
      const result=durable?await durable.update(id,patch):{...state,...patch};writeState(join(root,id+'.json'),result);return observe(result);
    };
    const cancelByAccount=async(accountId:string)=>{const active=await latest(accountId);return active?.status==='running'?[await cancel(active.id)]:[];};
    // A terminal progress receipt is the point at which the browser-run mutex
    // can be released.  Waiting for the child process' exit event creates a
    // small but user-visible race: the UI sees a completed/partial sync and
    // immediately starts draft saving while the old worker still owns the
    // account lock.  Keep blocked/unknown results locked until the original
    // computer confirms a stop.
    const update = durable?.update ? async (id:string, patch:Partial<XhsSyncJob>) => {
        const next = await durable.update(id, patch);
        observe(next);
        await notifyTerminal(next);
        return next;
    } : undefined;
    // A local connector writes the terminal receipt to its state file before
    // the child process exit event reaches this server. Release the account
    // mutex when that authoritative receipt is observed so a follow-up draft
    // task cannot be rejected during the short exit-event race.
    // Keep the in-process store's status lookup synchronous for local callers
    // (and the path-safety contract), while durable PostgreSQL jobs remain
    // asynchronous.  Both paths release the browser lease only after a
    // terminal receipt has been observed.
    const status = durable
        ? async (id: string) => {
            return observe(await durable.read(id));
        }
        : (id: string) => {
            return observe(readFile(id));
        };
    return {start:(accountId:string,profile:string,cli?:string,options?:XhsSyncOptions)=>serial(dir+':sync:'+accountId,()=>start(accountId,profile,cli,options)),latest,running,status,cancel,cancelByAccount,update,onTerminal:(handler:(job:XhsSyncJob)=>void|Promise<void>)=>{terminalHandlers.add(handler);return()=>terminalHandlers.delete(handler);}};
}

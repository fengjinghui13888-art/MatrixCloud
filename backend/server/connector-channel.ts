import {forwardedSecure,forwardedLocal} from './trusted-proxy';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { Pairing } from './postgres-pairing';
import type { Postgres } from './postgres';
import { channelStorage } from './channel-storage';
import { ConnectorError } from './connector-pairing';
// @ts-ignore shared ESM contract is also used by the packaged connector.
import { validConnectorCommand } from '../../shared/connector-protocol.mjs';
// @ts-ignore shared ESM contract is also used by the packaged connector.
import { validXhsEvent, validXhsSubscriptions } from '../../shared/xhs-events.mjs';
type Pending = {
    deviceId: string;
    resolve: (v: {
        status: number;
        data: Buffer;
        contentType: string;
    }) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    chunks: Buffer[];
    bytes: number;
    status: number;
    contentType: string;
};
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
export function createConnectorChannel(pairing: Pairing, file: string, db?: Postgres) {
    const storage = channelStorage(file, db);
    const peers = new Map<string, {
        socket: WebSocket;
        token: string;
    }>(), pending = new Map<string, Pending>(), eventHandlers = new Set<(input: any) => Promise<boolean>>(), connectedHandlers = new Set<(deviceId: string, workspace: string) => void | Promise<void>>();
    const online = async (id: string) => { const peer = peers.get(id); if (!peer || peer.socket.readyState !== WebSocket.OPEN)
        return false; try {
        (await pairing.authenticate(peer.token));
        return true;
    }
    catch {
        peer.socket.close(4001, 'revoked');
        return false;
    } };
    const binding = storage.binding, selected = storage.selected;
    const select = async (workspace: string, id: string) => { const d = await pairing.deviceById(id, workspace); if (!d || d.revokedAt !== null)
        throw new ConnectorError(404, '连接器不存在或已撤销'); await storage.select(workspace, id); };
    // Browser requests never inherit the workspace-wide legacy selection.
    // Count offline devices too: losing the Windows connection must not select a Mac.
    const browserDevice = async (workspace: string, choice?: string) => {
        if (!choice) {
            const devices = (await pairing.devices(workspace)).filter(d => !d.revoked);
            if (devices.length !== 1)
                throw new ConnectorError(409, devices.length ? '请在账号矩阵选择当前要执行的电脑' : '请先配对并启动客户电脑上的连接器');
            choice = devices[0].id;
        }
        const device = await pairing.deviceById(choice, workspace);
        if (!device || device.revokedAt !== null)
            throw new ConnectorError(403, '所选电脑不属于当前客户或已撤销，请重新选择');
        if (!await online(choice))
            throw new ConnectorError(409, `所选电脑“${device.name}”离线，请在该电脑启动连接器`);
        return choice;
    };
    const active = async (workspace: string) => {
        const choice = (await selected(workspace));
        if (choice) {
            if (!(await online(choice)))
                throw new ConnectorError(409, '已选择的连接器离线，请启动连接器');
            return choice;
        }
        const list = [];
        for (const d of await pairing.devices(workspace))
            if (!d.revoked && await online(d.id))
                list.push(d);
        if (list.length !== 1)
            throw new ConnectorError(409, list.length ? '请先选择用于添加账号的连接器' : '请先配对并启动客户电脑上的连接器');
        // A workspace with exactly one live customer computer can safely use it
        // as the default. Persisting that choice prevents a later sync from
        // falling back to the server's legacy local connector.
        await storage.select(workspace, list[0].id);
        return list[0].id;
    };
    const bind = async (workspace: string, profile: string, id?: string) => {
        id ??= await active(workspace);
        if (!/^local:[\w-]{1,100}$/.test(profile))
            throw new ConnectorError(400, '账号会话无效');
        const device = (await pairing.deviceById(id, workspace));
        if (!device || device.revokedAt !== null)
            throw new ConnectorError(403, '设备不属于当前客户');
        (await storage.bind(workspace, profile, id));
        if ((await binding(workspace, profile)) !== id)
            throw new ConnectorError(409, '此账号已绑定其他设备，请先在原设备处理');
        return id;
    };
    const ensureBinding = async (workspace: string, profile: string) => {
        const existing = await binding(workspace, profile);
        if (existing)
            return existing;
        return bind(workspace, profile, await active(workspace));
    };
    const authorize = async (workspace: string, deviceId: string, method: string, path: string, body?: any) => {
        const d = (await pairing.deviceById(deviceId, workspace));
        if (!d || d.revokedAt !== null)
            throw new ConnectorError(403, '连接器不属于当前客户或已撤销');
        if (!validConnectorCommand(method, path, body))
            throw new ConnectorError(400, '不支持的连接器操作');
        if (path === '/verify')
            return;
        const account = /^\/accounts\/([^/]+)/.exec(path);
        const profile = account ? 'local:' + account[1] : path === '/studio' ? body.profile : method === 'POST' && /^\/sync\/[^/]+$/.test(path) ? body.target.profile : null;
        if (profile) {
            if ((await binding(workspace, profile)) !== deviceId)
                throw new ConnectorError(403, '账号未绑定此连接器');
            if (!account) {
                const id = path === '/studio' ? body.runId : path.split('/')[2], kind = path === '/studio' ? 'studio' : 'sync';
                (await storage.addRun(workspace, id, deviceId, profile, kind));
                const row = await storage.run(workspace, id);
                if (row.device_id !== deviceId || row.profile !== profile || row.kind !== kind)
                    throw new ConnectorError(409, '任务绑定不一致');
            }
            return;
        }
        const [, kind, id] = path.split('/');
        const row = await storage.run(workspace, id);
        if (!row || row.device_id !== deviceId || row.kind !== kind)
            throw new ConnectorError(403, '任务不属于此客户和设备');
    };
    const request = async (workspace: string, deviceId: string, method: string, path: string, body?: any) => {
        (await authorize(workspace, deviceId, method, path, body));
        if (!(await online(deviceId)))
            throw new ConnectorError(409, '连接器离线，请保持客户电脑在线');
        if(method==='POST'&&(path==='/studio'||/^\/sync\/[^/]+$/.test(path)||/\/accounts\/[^/]+\/login$/.test(path))){
            const check=await request(workspace,deviceId,'GET','/verify');let device;try{device=JSON.parse(check.data.toString());}catch{}
            if(device?.version!==4||!['device-queue','stop-ack','passive-state','paced-actions'].every(c=>device.capabilities?.includes(c)))throw new ConnectorError(426,'请先升级此电脑的连接器，再开始新的自动化任务');
        }
        const peer = peers.get(deviceId)!, id = randomUUID();
        if ([...pending.values()].filter(p => p.deviceId === deviceId).length >= 8)
            throw new ConnectorError(429, '此设备任务过多，请稍后重试');
        return new Promise<{
            status: number;
            data: Buffer;
            contentType: string;
        }>((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); peer.socket.send(JSON.stringify({ type: 'cancel', id })); reject(new ConnectorError(504, '连接器响应超时，请核对任务状态后重试')); }, path.includes('/media/') ? 120000 : 60000);
            timer.unref();
            pending.set(id, { deviceId, resolve, reject, timer, chunks: [], bytes: 0, status: 200, contentType: 'application/json' });
            peer.socket.send(JSON.stringify({ type: 'request', id, method, path, ...(body !== undefined ? { body } : {}) }));
        });
    };
    const json = async (workspace: string, deviceId: string, method: string, path: string, body?: any) => {
        const r = await request(workspace, deviceId, method, path, body);
        let value;
        try {
            value = JSON.parse(r.data.toString());
        }
        catch {
            throw new ConnectorError(502, '连接器返回无效数据');
        }
        if (r.status >= 400)
            throw new ConnectorError(r.status, value.message || '连接器操作失败');
        return value;
    };
    const attach = (server: Server) => {
        const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
        server.on('upgrade', async (req, socket, head) => {
            if (req.url !== '/api/connector/channel') {
                socket.destroy();
                return;
            }
            const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host ?? '');
            if (!(req.socket as any).encrypted && !local && !forwardedSecure(req) && !forwardedLocal(req)) {
                socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
                return;
            }
            try {
                const token = /^Bearer ([a-f0-9]{64})$/i.exec(req.headers.authorization ?? '')?.[1] ?? '', device = (await pairing.authenticate(token));
                await pairing.heartbeat(token);
                wss.handleUpgrade(req, socket, head, (ws) => {
                    peers.get(device.id)?.socket.close(4000, 'replaced');
                    peers.set(device.id, { socket: ws, token });
                    for (const handler of connectedHandlers) void Promise.resolve(handler(device.id, device.workspace)).catch(() => {});
                    let alive = true;
                    const timer = setInterval(async () => { try {
                        (await pairing.authenticate(token));
                        if (!alive) {
                            ws.terminate();
                            return;
                        }
                        alive = false;
                        ws.ping();
                    }
                    catch {
                        ws.close(4001, 'revoked');
                    } }, 30000);
                    timer.unref();
                    ws.on('pong', async () => { alive = true; try {
                        (await pairing.heartbeat(token));
                    }
                    catch {
                        ws.close(4001, 'revoked');
                    } });
                    ws.on('error', () => ws.terminate());
                    // Events can wait for the persisted queue's drain lock while
                    // that drain is waiting for a connector command reply. Keep
                    // replies ordered independently so they can release it.
                    let eventFrames=Promise.resolve(), responseFrames=Promise.resolve();
                    const processFrame=async(m:any)=>{
                        try {
                            const p = pending.get(m.id);
                            if (m.type === 'event') {
                                await pairing.authenticate(token);
                                if (!validXhsEvent(m.event) || peers.get(device.id)?.socket !== ws) throw Error('invalid event');
                                const bound = await binding(device.workspace, m.event.profile);
                                if (!bound || bound !== device.id) throw Error('event binding mismatch');
                                const results = await Promise.all([...eventHandlers].map(handler => Promise.resolve(handler({workspace: device.workspace, deviceId: device.id, event: m.event})).catch(() => false)));
                                if (results.length && results.every(Boolean)) ws.send(JSON.stringify({type:'event-ack',eventId:m.event.eventId}));
                                return;
                            }
                            if (!p || p.deviceId !== device.id || peers.get(device.id)?.socket !== ws)
                                return;
                            if(m.type==='head'||m.type==='end'||m.type==='event')await pairing.authenticate(token);
                            if (m.type === 'head') {
                                if (!Number.isInteger(m.status) || m.status < 200 || m.status > 599)
                                    throw Error('invalid status');
                                p.status = m.status;
                                p.contentType = m.contentType === 'application/octet-stream' ? 'application/octet-stream' : 'application/json';
                            }
                            else if (m.type === 'chunk') {
                                if (typeof m.data !== 'string' || m.data.length > 100000)
                                    throw Error('invalid chunk');
                                const chunk = Buffer.from(m.data, 'base64');
                                p.bytes += chunk.length;
                                if (p.bytes > 64 * 1024 * 1024)
                                    throw Error('response too large');
                                p.chunks.push(chunk);
                            }
                            else if (m.type === 'end') {
                                clearTimeout(p.timer);
                                pending.delete(m.id);
                                p.resolve({ status: p.status, data: Buffer.concat(p.chunks), contentType: p.contentType });
                            }
                            else if (m.type === 'error') {
                                clearTimeout(p.timer);
                                pending.delete(m.id);
                                p.reject(new ConnectorError(502, '本机执行失败，请检查连接器日志'));
                            }
                        }
                        catch {
                            ws.close(4002, 'invalid response');
                        }
                    };
                    ws.on('message', raw => {
                        let message:any;
                        try {
                            message=JSON.parse(raw.toString());
                            if(!message||typeof message!=='object'||Array.isArray(message))throw Error('invalid frame');
                        }
                        catch { ws.close(4002,'invalid response');return; }
                        if(message.type==='event')eventFrames=eventFrames.then(()=>processFrame(message));
                        else responseFrames=responseFrames.then(()=>processFrame(message));
                    });
                    ws.on('close', () => { clearInterval(timer); if (peers.get(device.id)?.socket !== ws)
                        return; peers.delete(device.id); for (const [id, p] of pending)
                        if (p.deviceId === device.id) {
                            clearTimeout(p.timer);
                            pending.delete(id);
                            p.reject(new ConnectorError(503, '连接器已断开，任务结果尚未确认'));
                        } });
                });
            }
            catch {
                socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            }
        });
        server.on('close', () => { for (const p of peers.values())
            p.socket.terminate(); wss.close(); });
    };
    const close = (id: string) => peers.get(id)?.socket.close(4001, 'revoked');
    const onEvent = (handler: (input: any) => Promise<boolean>) => { eventHandlers.add(handler); return () => eventHandlers.delete(handler); };
    const onConnected = (handler: (deviceId: string, workspace: string) => void | Promise<void>) => { connectedHandlers.add(handler as any); return () => connectedHandlers.delete(handler as any); };
    const watch = (deviceId: string, subscriptions: any[]) => {
        if (!validXhsSubscriptions(subscriptions)) throw new ConnectorError(400, '事件订阅无效');
        const peer = peers.get(deviceId); if (!peer || peer.socket.readyState !== WebSocket.OPEN) throw new ConnectorError(409, '连接器离线');
        void peer.socket.send(JSON.stringify({ type: 'watch', subscriptions }));
    };
    return { attach, request, json, online, binding, bind, ensureBinding, selected, select, active, browserDevice, close, onEvent, onConnected, watch };
}
export type ConnectorChannel = ReturnType<typeof createConnectorChannel>;

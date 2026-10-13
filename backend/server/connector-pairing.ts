import {forwardedLocal} from './trusted-proxy';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { runSqliteJson } from './sqlite-client';
import { dirname } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { ConnectorChannel } from './connector-channel';
import type { Pairing } from './postgres-pairing';
import type { Auth } from './tenant-auth';
type Device = {
    id: string;
    workspace: string;
    name: string;
    platform: string;
    version: string;
    createdAt: string;
    lastSeenAt: number;
    revokedAt: number | null;
};
export class ConnectorError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const connectorToken = (req: Request) => /^Bearer ([a-f0-9]{64})$/i.exec(req.header('authorization') ?? '')?.[1] ?? '';
const deviceColumns = 'id,workspace,name,platform,version,created_at AS createdAt,last_seen_at AS lastSeenAt,revoked_at AS revokedAt';
export function createConnectorPairing(filePath: string, { now = Date.now }: {
    now?: () => number;
} = {}) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const sql = <T = Record<string, any>>(query: string): T[] => {
        const raw = runSqliteJson(filePath, query).trim();
        return raw ? JSON.parse(raw) : [];
    };
    sql(`CREATE TABLE IF NOT EXISTS connector_pairings(
    id TEXT PRIMARY KEY, workspace TEXT NOT NULL, code_hash TEXT UNIQUE NOT NULL,
    expires_at INTEGER NOT NULL, status TEXT NOT NULL, device_id TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS connector_devices(
    id TEXT PRIMARY KEY, workspace TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL,
    version TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL, revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS connector_limits(key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS connector_devices_workspace_idx ON connector_devices(workspace,last_seen_at);
  CREATE INDEX IF NOT EXISTS connector_pairings_workspace_idx ON connector_pairings(workspace,created_at);`);
    chmodSync(filePath, 0o600);
    const rate = (key: string, max: number, period: number) => {
        const stamp = Math.floor(now() / period);
        const row = sql(`INSERT INTO connector_limits(key,window,count) VALUES(${quote(key)},${stamp},1)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count;`)[0];
        if (row.count > max)
            throw new ConnectorError(429, '操作过于频繁，请稍后再试');
    };
    const expire = () => sql(`UPDATE connector_pairings SET status='expired' WHERE status='pending' AND expires_at<=${now()};
    DELETE FROM connector_pairings WHERE expires_at<${now() - 86400000} AND status!='pending';
    DELETE FROM connector_limits WHERE (key LIKE 'register:%' AND window<${Math.floor(now() / 60000) - 2}) OR (key LIKE 'issue:%' AND window<${Math.floor(now() / 3600000) - 2});`);
    const deviceById = (id: string, workspace: string) => sql<Device>(`SELECT ${deviceColumns} FROM connector_devices WHERE id=${quote(id)} AND workspace=${quote(workspace)};`)[0];
    const authenticate = (token: string) => {
        if (!/^[a-f0-9]{64}$/i.test(token))
            throw new ConnectorError(401, '连接器凭证无效或已撤销，请重新配对');
        const device = sql<Device>(`SELECT ${deviceColumns} FROM connector_devices WHERE token_hash=${quote(digest(token))} AND revoked_at IS NULL;`)[0];
        if (!device)
            throw new ConnectorError(401, '连接器凭证无效或已撤销，请重新配对');
        return device;
    };
    const publicDevice = (d: Device) => ({ id: d.id, name: d.name, platform: d.platform, version: d.version, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : null, online: d.revokedAt === null && d.lastSeenAt > 0 && now() - d.lastSeenAt <= 90000, revoked: d.revokedAt !== null });
    const devices = (workspace: string) => sql<Device>(`SELECT ${deviceColumns} FROM connector_devices WHERE workspace=${quote(workspace)} ORDER BY created_at DESC;`).map(publicDevice);
    const create = (workspace: string) => {
        expire();
        rate('issue:' + workspace, 10, 3600000);
        const id = randomUUID(), code = String(randomInt(0, 100000000)).padStart(8, '0'), expiresAt = now() + 300000;
        sql(`BEGIN IMMEDIATE;UPDATE connector_pairings SET status='cancelled' WHERE workspace=${quote(workspace)} AND status='pending';
      INSERT INTO connector_pairings(id,workspace,code_hash,expires_at,status,created_at) VALUES(${quote(id)},${quote(workspace)},${quote(digest(code))},${expiresAt},'pending',${quote(new Date(now()).toISOString())});COMMIT;`);
        return { id, code, status: 'pending' as const, expiresAt, expiresInSeconds: 300 };
    };
    const pairingStatus = (id: string, workspace: string) => {
        expire();
        const row = sql(`SELECT id,status,expires_at AS expiresAt,device_id AS deviceId FROM connector_pairings WHERE id=${quote(id)} AND workspace=${quote(workspace)};`)[0];
        if (!row)
            throw new ConnectorError(404, '配对任务不存在');
        const device = row.deviceId ? deviceById(row.deviceId, workspace) : undefined;
        return { id: row.id, status: row.status, expiresAt: row.expiresAt, device: device ? publicDevice(device) : undefined };
    };
    const register = (code: string, name: string, platform: string, version: string, source = 'local') => {
        expire();
        rate('register:' + digest(source), 10, 60000);
        rate('register:global', 500, 60000);
        if (!/^\d{8}$/.test(code) || !name.trim() || name.length > 100 || /[\u0000-\u001f]/.test(name) || !['darwin', 'win32', 'linux'].includes(platform) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) || version.length > 40)
            throw new ConnectorError(400, '连接器注册参数无效');
        const id = randomUUID(), token = randomBytes(32).toString('hex'), stamp = now();
        const result = sql(`BEGIN IMMEDIATE;
      INSERT INTO connector_devices(id,workspace,name,platform,version,token_hash,created_at,last_seen_at)
      SELECT ${quote(id)},workspace,${quote(name.trim())},${quote(platform)},${quote(version)},${quote(digest(token))},${quote(new Date(stamp).toISOString())},0 FROM connector_pairings
      WHERE code_hash=${quote(digest(code))} AND status='pending' AND expires_at>${stamp};
      UPDATE connector_pairings SET status='claimed',device_id=${quote(id)} WHERE code_hash=${quote(digest(code))} AND status='pending' AND EXISTS(SELECT 1 FROM connector_devices WHERE id=${quote(id)});
      SELECT workspace FROM connector_devices WHERE id=${quote(id)};COMMIT;`);
        if (!result.length)
            throw new ConnectorError(409, '配对码无效、已使用或已过期，请生成新码');
        return { deviceId: id, deviceToken: token, workspace: result[0].workspace, heartbeatIntervalSeconds: 30 };
    };
    const heartbeat = (token: string) => {
        const device = authenticate(token);
        const result = sql<Device>(`UPDATE connector_devices SET last_seen_at=${now()} WHERE id=${quote(device.id)} AND revoked_at IS NULL RETURNING ${deviceColumns};`);
        if (!result.length)
            throw new ConnectorError(401, '连接器已撤销');
        return { ok: true, device: publicDevice(result[0]) };
    };
    const revoke = (id: string, workspace: string) => {
        if (!deviceById(id, workspace))
            throw new ConnectorError(404, '连接器不存在');
        sql(`UPDATE connector_devices SET revoked_at=coalesce(revoked_at,${now()}) WHERE id=${quote(id)} AND workspace=${quote(workspace)};`);
        return { ok: true, id };
    };
    const cancel = (id: string, workspace: string) => {
        pairingStatus(id, workspace);
        sql(`UPDATE connector_pairings SET status='cancelled' WHERE id=${quote(id)} AND workspace=${quote(workspace)} AND status='pending';`);
        return pairingStatus(id, workspace);
    };
    return { create, pairingStatus, devices, register, heartbeat, revoke, cancel, authenticate, deviceById, publicDevice, workspaceOfToken: (token: string) => { try {
            return authenticate(token).workspace;
        }
        catch {
            return null;
        } } };
}
export function trustedConnectorTransport(req: Request) {
    // Trust Express TLS only; forwarded headers must never turn public HTTP into TLS.
    return req.secure || forwardedLocal(req) || (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip ?? '') && ['localhost', '127.0.0.1', '[::1]'].includes(req.hostname));
}
const browserDeviceCookie = 'matrix_execution_device';
export function requestedBrowserDevice(req: Request, workspace: string) {
    const raw = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(browserDeviceCookie + '='))?.slice(browserDeviceCookie.length + 1);
    try {
        const value = decodeURIComponent(raw ?? '');
        return value.startsWith(workspace + ':') ? value.slice(workspace.length + 1) || undefined : undefined;
    } catch { return undefined; }
}
function rememberBrowserDevice(req: Request, res: Response, workspace: string, id: string) {
    res.cookie(browserDeviceCookie, workspace + ':' + id, {httpOnly:true, secure:req.secure, sameSite:'strict', path:'/api', maxAge:365*86400000});
}
export function connectorPairingRoutes(app: Express, pairing: Pairing, auth: Pick<Auth, 'user' | 'workspace' | 'sameOrigin'>, channel?: ConnectorChannel) {
    const webWorkspace = async (req: Request) => { const workspace = (await auth.user(req)) ? (await auth.workspace(req)) : null; if (!workspace)
        throw new ConnectorError(401, '请先登录工作台'); return workspace; };
    const secure = (req: Request) => { if (!trustedConnectorTransport(req))
        throw new ConnectorError(426, '客户连接器需要 HTTPS 地址，请先完成安全访问配置'); };
    const origin = async (req: Request) => { if (!(await auth.sameOrigin(req)))
        throw new ConnectorError(403, '请从工作台页面操作'); };
    const wrap = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => { res.set('Cache-Control', 'no-store'); try {
        await fn(req, res);
    }
    catch (e) {
        res.status(e instanceof ConnectorError ? e.status : e instanceof z.ZodError ? 400 : 500).json({ message: e instanceof ConnectorError ? e.message : e instanceof z.ZodError ? '连接器注册参数无效' : '连接器服务暂时不可用，请稍后重试' });
    } };
    app.get('/api/connector/capabilities', wrap(async (req, res) => { (await webWorkspace(req)); res.json({ secure: trustedConnectorTransport(req), pairingTtlSeconds: 300, customerExecution: !!channel }); }));
    app.post('/api/connector/pairings', wrap(async (req, res) => { (await origin(req)); const workspace = (await webWorkspace(req)); secure(req); res.status(201).json((await pairing.create(workspace))); }));
    app.get('/api/connector/pairings/:id', wrap(async (req, res) => {
        const workspace = await webWorkspace(req), state = await pairing.pairingStatus(String(req.params.id), workspace);
        if (state.status === 'claimed' && state.device && !state.device.revoked)
            rememberBrowserDevice(req, res, workspace, state.device.id);
        res.json(state);
    }));
    app.post('/api/connector/pairings/:id/cancel', wrap(async (req, res) => { (await origin(req)); res.json((await pairing.cancel(String(req.params.id), (await webWorkspace(req))))); }));
    app.get('/api/connector/devices', wrap(async (req, res) => {
        const workspace = await webWorkspace(req), devices = await pairing.devices(workspace);
        const choice = requestedBrowserDevice(req, workspace), available = devices.filter(d => !d.revoked);
        const selectedDeviceId = choice ? available.find(d => d.id === choice)?.id : available.length === 1 ? available[0].id : undefined;
        res.json({selectedDeviceId, devices:await Promise.all(available.map(async d => ({...d,executionReady:!!await channel?.online(d.id)})))});
    }));
    app.post('/api/connector/devices/:id/revoke', wrap(async (req, res) => { (await origin(req)); const result = (await pairing.revoke(String(req.params.id), (await webWorkspace(req)))); (await channel?.close(String(req.params.id))); res.json(result); }));
    app.post('/api/connector/devices/:id/select', wrap(async (req, res) => { (await origin(req)); if (!channel)
        throw new ConnectorError(503, '任务通道未启用'); const workspace = await webWorkspace(req), id = await channel.browserDevice(workspace, String(req.params.id)); rememberBrowserDevice(req, res, workspace, id); res.json({ ok: true, deviceId:id }); }));
    app.post('/api/connector/devices/:id/cleanup',wrap(async(req,res)=>{await origin(req);const workspace=await webWorkspace(req);if(!channel)throw new ConnectorError(503,'任务通道未启用');const device=(await pairing.devices(workspace)).find(d=>d.id===req.params.id&&!d.revoked);if(!device)throw new ConnectorError(404,'设备不存在');if(!await channel.online(device.id))return res.status(202).json({status:'pending',message:'设备离线，清理待处理'});const body=z.object({manifestId:z.string().uuid().optional()}).strict().parse(req.body);res.json(await channel.json(workspace,device.id,'POST','/cleanup',body));}));
    app.post('/api/connector/register', wrap(async (req, res) => {
        secure(req);
        if (!req.is('application/json'))
            throw new ConnectorError(415, '请求格式必须为 JSON');
        const input = z.object({ code: z.string().regex(/^\d{8}$/), deviceName: z.string().trim().min(1).max(100), platform: z.enum(['darwin', 'win32', 'linux']), version: z.string().min(1).max(40) }).strict().parse(req.body);
        const registered=await pairing.register(input.code, input.deviceName, input.platform, input.version, req.ip ?? 'unknown');
        // Completing an explicit pairing selects that computer for the next
        // account login. Existing accounts keep their verified device binding.
        await channel?.select(registered.workspace,registered.deviceId);
        res.status(201).json(registered);
    }));
    app.post('/api/connector/heartbeat', wrap(async (req, res) => { secure(req); res.json((await pairing.heartbeat(connectorToken(req)))); }));
}

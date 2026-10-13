import type { ConnectorChannel } from './connector-channel';
import type { createLocalConnector } from './local-connector';
export function createCustomerConnector(channel: ConnectorChannel, _legacy: ReturnType<typeof createLocalConnector>, workspace: () => string) {
    const route = async (profile: string, _create = false) => {
        const w = workspace(), bound = (await channel.binding(w, profile));
        if (bound)
            return bound;
        throw Error('此账号尚未在客户电脑上登录，请重新扫码');
    };
    const call = async (id: string, action: string) => {
        const w = workspace(), device = (await route('local:' + id, action === 'login'));
        return (await channel.json(w, device, ['state', 'image'].includes(action) ? 'GET' : 'POST', `/accounts/${id}/${action}`));
    };
    const status = async (deviceId?: string) => {
        const w = workspace();
        try {
            const id = (await channel.browserDevice(w, deviceId));
            return { ...await channel.json(w, id, 'GET', '/verify'), deviceId: id, transport: 'customer-channel' };
        }
        catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : '连接器未连接' };
        }
    };
    const ensure = async (profile?: string) => {
        if (profile) {
            const w = workspace(), id = (await route(profile));
            return (await channel.json(w, id, 'GET', '/verify'));
        }
        const state = await status();
        if (!state?.ok)
            throw Error(state?.message || '连接器未连接');
        return state;
    };
    return { status, ensure, route, login: async (id: string, deviceId?: string) => {
        const w = workspace(), device = await channel.browserDevice(w, deviceId);
        await channel.bind(w, 'local:' + id, device);
        return call(id, 'login');
    }, cancel:(id:string)=>call(id,'cancel'),state: (id: string) => call(id, 'state'), image: (id: string) => call(id, 'image'), remove: (id: string) => call(id, 'remove') };
}

import { expect, it, vi } from 'vitest';
import { createCustomerConnector } from '../customer-connector';

function fixture(workspace: string) {
  const legacy = {
    status: vi.fn(async () => ({ ok: true, connector: 'legacy' })),
    ensure: vi.fn(async () => ({ ok: true, connector: 'legacy' })),
    login: vi.fn(async () => ({ connector: 'legacy' })),
    state: vi.fn(async () => ({ connector: 'legacy' })),
    image: vi.fn(async () => ({ connector: 'legacy' })),
    remove: vi.fn(async () => true),
  };
  const channel = {
    binding: vi.fn(async () => undefined),
    ensureBinding: vi.fn(async () => 'customer-device'),
    json: vi.fn(async (_workspace: string, _device: string, _method: string, path: string) => ({ path })),
    active: vi.fn(),
    browserDevice: vi.fn(),
    selected: vi.fn(),
  } as any;
  return { connector: createCustomerConnector(channel, legacy as any, () => workspace), channel, legacy };
}

it('routes an owner account to a paired customer computer instead of the legacy local connector', async () => {
  const { connector, channel, legacy } = fixture('owner');
  channel.binding.mockResolvedValue('customer-device');
  await expect(connector.state('profile-a')).resolves.toEqual({ path: '/accounts/profile-a/state' });
  expect(channel.json).toHaveBeenCalledWith('owner', 'customer-device', 'GET', '/accounts/profile-a/state');
  expect(legacy.state).not.toHaveBeenCalled();
});

it('never falls back to the owner connector when no customer computer exists', async () => {
  const { connector, channel, legacy } = fixture('owner');
  channel.ensureBinding.mockRejectedValue(new Error('请先配对并启动客户电脑上的连接器'));
  await expect(connector.state('profile-a')).rejects.toThrow();
  expect(legacy.state).not.toHaveBeenCalled();
});

it('does not fall back for a customer workspace when its execution computer is unavailable', async () => {
  const { connector, channel, legacy } = fixture('customer');
  channel.ensureBinding.mockRejectedValue(new Error('请先配对并启动客户电脑上的连接器'));
  await expect(connector.state('profile-a')).rejects.toThrow('请重新扫码');
  expect(legacy.state).not.toHaveBeenCalled();
});

it('surfaces an ambiguous paired-device choice instead of choosing the server', async () => {
  const { connector, channel, legacy } = fixture('owner');
  channel.browserDevice.mockRejectedValue(new Error('请在账号矩阵选择当前要执行的电脑'));
  await expect(connector.login('profile-a')).rejects.toThrow('请在账号矩阵选择当前要执行的电脑');
  expect(legacy.state).not.toHaveBeenCalled();
});

it('does not report the owner connector as healthy when several customer computers need selection', async () => {
  const { connector, channel, legacy } = fixture('owner');
  channel.browserDevice.mockRejectedValue(new Error('请在账号矩阵选择当前要执行的电脑'));
  await expect(connector.status()).resolves.toEqual({ ok: false, message: '请在账号矩阵选择当前要执行的电脑' });
  expect(legacy.status).not.toHaveBeenCalled();
});

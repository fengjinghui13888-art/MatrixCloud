import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type ApiKeyRecord = { id: string; name: string; prefix: string; hash: string; createdAt: string; revokedAt?: string };
export type UsageEntry = { id: string; action: string; units: number; description: string; createdAt: string };
type TopupOrder = { id: string; plan: string; credits: number; status: 'pending' | 'paid'; createdAt: string; paymentReference?: string };
type BillingData = { balanceCredits: number; apiKeys: ApiKeyRecord[]; usage: UsageEntry[]; orders: TopupOrder[] };
export type BillingSummary = { balanceCredits: number; apiKeys: Array<Pick<ApiKeyRecord, 'id' | 'name' | 'prefix' | 'createdAt' | 'revokedAt'>>; recentUsage: UsageEntry[] };
export type BillingService = { createApiKey(name: string): { id: string; prefix: string; secret: string }; verifyApiKey(secret: string): Pick<ApiKeyRecord, 'id' | 'name' | 'prefix'> | undefined; debit(input: Omit<UsageEntry, 'id' | 'createdAt'>): UsageEntry; createTopupOrder(plan: string): TopupOrder; completeTopup(orderId: string, paymentReference: string): TopupOrder; summary(): BillingSummary };

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fresh = (): BillingData => ({ balanceCredits: 3000, apiKeys: [], usage: [], orders: [] });

export function createBillingService(filePath: string): BillingService {
  mkdirSync(dirname(filePath), { recursive: true });
  let data: BillingData = existsSync(filePath) ? { ...fresh(), ...JSON.parse(readFileSync(filePath, 'utf8')) } : fresh();
  const persist = () => writeFileSync(filePath, JSON.stringify(data, null, 2));
  return {
    createApiKey(name) {
      const secret = `zx_live_${randomBytes(24).toString('base64url')}`;
      const record: ApiKeyRecord = { id: randomUUID(), name: name.trim() || '未命名密钥', prefix: secret.slice(0, 14), hash: hash(secret), createdAt: new Date().toISOString() };
      data.apiKeys.unshift(record); persist(); return { id: record.id, prefix: record.prefix, secret };
    },
    verifyApiKey(secret) { const record = data.apiKeys.find((item) => !item.revokedAt && item.hash === hash(secret)); return record ? { id: record.id, name: record.name, prefix: record.prefix } : undefined; },
    debit(input) {
      if (input.units <= 0) throw new Error('扣费额度必须大于 0');
      if (data.balanceCredits < input.units) throw new Error('平台额度不足，请充值后重试');
      const entry: UsageEntry = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
      data.balanceCredits -= input.units; data.usage.unshift(entry); persist(); return entry;
    },
    createTopupOrder(plan) {
      const credits = plan === 'pro' ? 5000 : plan === 'team' ? 20000 : 1000;
      const order: TopupOrder = { id: `ord_${randomUUID()}`, plan, credits, status: 'pending', createdAt: new Date().toISOString() };
      data.orders.unshift(order); persist(); return order;
    },
    completeTopup(orderId, paymentReference) {
      const order = data.orders.find((item) => item.id === orderId);
      if (!order) throw new Error('充值订单不存在');
      if (order.status === 'paid') return order;
      order.status = 'paid'; order.paymentReference = paymentReference; data.balanceCredits += order.credits;
      data.usage.unshift({ id: randomUUID(), action: 'topup', units: order.credits, description: `充值套餐 ${order.plan}`, createdAt: new Date().toISOString() }); persist(); return order;
    },
    summary: () => ({ balanceCredits: data.balanceCredits, apiKeys: data.apiKeys.map(({ id, name, prefix, createdAt, revokedAt }) => ({ id, name, prefix, createdAt, revokedAt })), recentUsage: data.usage.slice(0, 20) })
  };
}

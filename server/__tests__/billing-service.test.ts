import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createBillingService } from '../billing-service';

describe('billing service', () => {
  test('creates a customer API key while storing only its hash', () => {
    const billing = createBillingService(join(mkdtempSync(join(tmpdir(), 'zhixu-billing-')), 'billing.json'));

    const created = billing.createApiKey('WorkBuddy 生产连接');

    expect(created.secret).toMatch(/^zx_live_/);
    expect(billing.verifyApiKey(created.secret)?.name).toBe('WorkBuddy 生产连接');
    expect(JSON.stringify(billing.summary())).not.toContain(created.secret);
  });

  test('debits task credits and keeps an auditable ledger', () => {
    const billing = createBillingService(join(mkdtempSync(join(tmpdir(), 'zhixu-billing-')), 'billing.json'));
    const before = billing.summary().balanceCredits;

    const entry = billing.debit({ units: 10, action: 'xhs_publish_task', description: '创建小红书草稿任务' });

    expect(billing.summary().balanceCredits).toBe(before - 10);
    expect(billing.summary().recentUsage[0]).toEqual(entry);
  });

  test('tops up credits with a pending order that can be completed by a payment callback', () => {
    const billing = createBillingService(join(mkdtempSync(join(tmpdir(), 'zhixu-billing-')), 'billing.json'));

    const order = billing.createTopupOrder('starter');
    expect(order.status).toBe('pending');
    expect(order.credits).toBe(1000);
    billing.completeTopup(order.id, 'demo-payment');

    expect(billing.summary().balanceCredits).toBe(4000);
    expect(billing.summary().recentUsage[0].action).toBe('topup');
  });
});

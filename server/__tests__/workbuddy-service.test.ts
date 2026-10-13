import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createWorkbuddyTaskService } from '../workbuddy-service';

describe('WorkBuddy task service', () => {
  test('creates a draft task that waits for the customer browser bridge', () => {
    const service = createWorkbuddyTaskService(join(mkdtempSync(join(tmpdir(), 'zhixu-workbuddy-')), 'tasks.json'));

    const task = service.create({ accountId: 'acc-1', title: '周末徒步路线', body: '请整理成图文笔记', delivery: 'draft' });

    expect(task.status).toBe('awaiting_browser');
    expect(task.delivery).toBe('draft');
    expect(service.list()).toContainEqual(task);
  });

  test('requires explicit confirmation before it accepts a publish task', () => {
    const service = createWorkbuddyTaskService(join(mkdtempSync(join(tmpdir(), 'zhixu-workbuddy-')), 'tasks.json'));

    expect(() => service.create({ accountId: 'acc-1', title: '周末徒步路线', body: '请整理成图文笔记', delivery: 'publish' })).toThrow('发布任务需要明确确认');
  });
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export type DeliveryMode = 'draft' | 'publish';
export type WorkbuddyTask = { id: string; accountId: string; title: string; body: string; delivery: DeliveryMode; status: 'awaiting_browser'; createdAt: string };
type CreateTask = { accountId: string; title: string; body: string; delivery: DeliveryMode; confirmPublish?: boolean };

export type WorkbuddyTaskService = { create(input: CreateTask): WorkbuddyTask; list(): WorkbuddyTask[] };

export function createWorkbuddyTaskService(filePath: string): WorkbuddyTaskService {
  mkdirSync(dirname(filePath), { recursive: true });
  let tasks: WorkbuddyTask[] = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : [];
  const persist = () => writeFileSync(filePath, JSON.stringify(tasks, null, 2));
  return {
    create(input) {
      if (input.delivery === 'publish' && !input.confirmPublish) throw new Error('发布任务需要明确确认');
      const task: WorkbuddyTask = { id: randomUUID(), accountId: input.accountId, title: input.title, body: input.body, delivery: input.delivery, status: 'awaiting_browser', createdAt: new Date().toISOString() };
      tasks.unshift(task); persist(); return task;
    },
    list: () => tasks
  };
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveProjectPath } from './runtime-paths.js';
import { createStore, type Store } from './store';
import { createWorkbuddyTaskService, type WorkbuddyTaskService } from './workbuddy-service';
import type { UsageEntry } from './billing-service';

const text = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] });

export function createWorkbuddyMcpServer(options: { store?: Store; tasks?: WorkbuddyTaskService; beforeCreateTask?: (input: { action: string; units: number; description: string }) => UsageEntry | void } = {}) {
  const store = options.store ?? createStore(resolveProjectPath('work/xhs-matrix-data.json'));
  const tasks = options.tasks ?? createWorkbuddyTaskService(resolveProjectPath('work/workbuddy-publish-tasks.json'));
  const server = new McpServer({ name: 'zhixu-xhs-operations', version: '0.1.0' });

  server.registerTool('get_xhs_operations_overview', {
    title: '获取小红书运营概览',
    description: '获取账号矩阵、待处理互动和已创建线索摘要。适合回答运营状态、优先处理哪些评论等问题。'
  }, async () => text({
    accounts: store.listAccounts().map((account) => ({ id: account.id, name: account.name, handle: account.handle, syncState: account.state })),
    pendingComments: store.listComments().filter((comment) => comment.status === 'pending').map((comment) => ({ id: comment.id, accountId: comment.accountId, author: comment.author, body: comment.body, tags: comment.tags })),
    leads: store.listLeads().length
  }));

  server.registerTool('create_xhs_publish_task', {
    title: '创建小红书发布任务',
    description: '创建保存草稿或发布任务。发布模式必须显式传入 confirm_publish=true；任务创建后等待客户本机 OpenCLI 浏览器桥接执行。',
    inputSchema: {
      account_id: z.string().describe('知序账号 ID，例如 acc-1'), title: z.string().min(1).max(20).describe('小红书标题，最多 20 字'), body: z.string().min(1).describe('已确认的笔记正文'),
      delivery: z.enum(['draft', 'publish']).describe('draft 保存草稿；publish 发布'), confirm_publish: z.boolean().optional().describe('仅 delivery=publish 时必须为 true')
    }, annotations: { destructiveHint: true }
  }, async ({ account_id, title, body, delivery, confirm_publish }) => {
    const account = store.listAccounts().find((item) => item.id === account_id);
    if (!account) return text({ error: '未找到账号', next_action: '先调用 get_xhs_operations_overview 获取合法账号 ID。' });
    try {
      const usage = options.beforeCreateTask?.({ action: 'xhs_publish_task', units: delivery === 'publish' ? 20 : 10, description: delivery === 'publish' ? '创建小红书发布任务' : '创建小红书草稿任务' });
      return text({ task: tasks.create({ accountId: account_id, title, body, delivery, confirmPublish: confirm_publish }), usage, next_action: '请在目标账号已登录的 Chrome Profile 中连接 OpenCLI Browser Bridge 后执行。' });
    }
    catch (error) { return text({ error: error instanceof Error ? error.message : '任务创建失败', next_action: '发布任务必须先向用户确认，再携带 confirm_publish=true 重试。' }); }
  });

  server.registerTool('list_xhs_publish_tasks', { title: '查询小红书发布任务', description: '查询当前等待客户本机浏览器桥接执行的发布和草稿任务。' }, async () => text({ tasks: tasks.list() }));
  return server;
}

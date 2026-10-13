import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, test } from 'vitest';
import { createStore } from '../store';
import { createWorkbuddyMcpServer } from '../workbuddy-mcp-server';
import { createWorkbuddyTaskService } from '../workbuddy-service';

describe('metered WorkBuddy publishing', () => {
  test('charges a workflow unit before creating a draft task', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'zhixu-mcp-billing-'));
    let charged = 0;
    const server = createWorkbuddyMcpServer({ store: createStore(join(directory, 'data.json')), tasks: createWorkbuddyTaskService(join(directory, 'tasks.json')), beforeCreateTask: () => { charged += 10; } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'metering-test', version: '0.1.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'create_xhs_publish_task', arguments: { account_id: 'acc-1', title: '徒步路线', body: '请保存为草稿', delivery: 'draft' } });
    await client.close();

    expect(result.isError).not.toBe(true);
    expect(charged).toBe(10);
  });
});

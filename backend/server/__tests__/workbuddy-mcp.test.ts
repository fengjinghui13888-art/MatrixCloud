import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('WorkBuddy MCP server', () => {
  test('exposes operations and controlled publishing tools over stdio', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'server', 'workbuddy-mcp.ts')], cwd: root, stderr: 'pipe' });
    const client = new Client({ name: 'zhixu-test', version: '0.1.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['get_xhs_operations_overview', 'create_xhs_publish_task', 'list_xhs_publish_tasks']));
  }, 15_000);
});

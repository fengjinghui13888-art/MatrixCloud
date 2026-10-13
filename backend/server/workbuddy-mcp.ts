import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createWorkbuddyMcpServer } from './workbuddy-mcp-server';

const server = createWorkbuddyMcpServer();

await server.connect(new StdioServerTransport());

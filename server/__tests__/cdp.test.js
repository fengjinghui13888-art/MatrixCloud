// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { openCdp } from '../../local-connector/cdp.mjs';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

it('opens a Chrome CDP socket with the bundled WebSocket client', async () => {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await new Promise(resolve => server.once('listening', resolve));
  server.on('connection', socket => socket.on('message', raw => {
    const request = JSON.parse(raw.toString());
    socket.send(JSON.stringify({ id: request.id, result: { accepted: true } }));
  }));

  const port = server.address().port;
  const client = await openCdp(`ws://127.0.0.1:${port}`);
  await expect(client.send('Runtime.enable')).resolves.toEqual({ accepted: true });
  client.close();
});

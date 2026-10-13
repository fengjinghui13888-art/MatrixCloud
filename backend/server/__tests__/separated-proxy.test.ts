// @vitest-environment node
import { it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { IncomingMessage } from 'node:http';
import { configureTrustedProxy, forwardedSecure } from '../trusted-proxy';

it('accepts HTTPS forwarding only from the explicitly configured frontend container', () => {
  vi.stubEnv('TRUSTED_PROXY_IPS', '172.30.83.10');
  vi.stubEnv('TRUST_LOOPBACK_PROXY', '0');
  const req = (address: string) => ({ socket: { remoteAddress: address }, headers: { 'x-forwarded-proto': 'https' } }) as unknown as IncomingMessage;
  try {
    expect(forwardedSecure(req('172.30.83.10'))).toBe(true);
    expect(forwardedSecure(req('::ffff:172.30.83.10'))).toBe(true);
    expect(forwardedSecure(req('172.30.83.11'))).toBe(false);
    expect(forwardedSecure(req('198.51.100.1'))).toBe(false);
  } finally { vi.unstubAllEnvs(); }
});

it('keeps authenticated proxy request host and protocol while refusing forwarding from other callers', async () => {
  vi.stubEnv('TRUSTED_PROXY_IPS', '127.0.0.1');
  vi.stubEnv('TRUST_LOOPBACK_PROXY', '0');
  try {
    const app = express(); configureTrustedProxy(app);
    app.get('/', (req, res) => res.json({ secure: req.secure, host: req.get('host') }));
    expect((await request(app).get('/').set('Host', 'workspace.test').set('X-Forwarded-Proto', 'https')).body)
      .toEqual({ secure: true, host: 'workspace.test' });
    vi.stubEnv('TRUSTED_PROXY_IPS', '172.30.83.10');
    expect((await request(app).get('/').set('Host', 'workspace.test').set('X-Forwarded-Proto', 'https')).body.secure).toBe(false);
  } finally { vi.unstubAllEnvs(); }
});

// @vitest-environment node
import express from 'express';
import request from 'supertest';
import { it, expect, vi } from 'vitest';
import { configureTrustedProxy, forwardedLocal } from '../trusted-proxy';
import { trustedConnectorTransport } from '../connector-pairing';

it('allows only an explicitly enabled development proxy for the configured loopback workbench', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('TRUST_LOCAL_PROXY_HTTP', '1');
  vi.stubEnv('TRUSTED_PROXY_IPS', '127.0.0.1');
  vi.stubEnv('TRUST_LOOPBACK_PROXY', '0');
  vi.stubEnv('PUBLIC_ORIGIN', 'http://127.0.0.1:8080');
  try {
    const app = express(); configureTrustedProxy(app);
    app.get('/', (req, res) => res.json({ allowed: trustedConnectorTransport(req) }));
    const call = (host = '127.0.0.1:8080') => request(app).get('/').set('Host', host)
      .set('X-Forwarded-For', '198.51.100.10').set('X-Forwarded-Proto', 'http');
    expect((await call()).body.allowed).toBe(true);
    expect((await call('public.test')).body.allowed).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    expect((await call()).body.allowed).toBe(false);
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('TRUST_LOCAL_PROXY_HTTP', '0');
    expect((await call()).body.allowed).toBe(false);
    vi.stubEnv('TRUST_LOCAL_PROXY_HTTP', '1'); vi.stubEnv('TRUSTED_PROXY_IPS', '172.30.83.10');
    expect(forwardedLocal({socket:{remoteAddress:'172.30.83.11'},headers:{host:'127.0.0.1:8080','x-forwarded-proto':'http'}} as any)).toBe(false);
  } finally { vi.unstubAllEnvs(); }
});

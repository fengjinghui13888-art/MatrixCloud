#!/usr/bin/env python3
"""Read-only regression check for this installation's public HTTP/TLS boundary."""
import json
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def check(host):
    opener = urllib.request.build_opener(NoRedirect())
    results = []
    for scheme, path, expected in [
        ('http', '/', 308),
        ('http', '/.well-known/', 308),
        ('http', '/.well-known/acme-challenge/', 308),
        ('http', '/.well-known/acme-challenge/definitely-missing-token', 404),
        ('http', '/.well-known/acme-challenge/%2e%2e/private.txt', 308),
        ('https', '/api/health', 200),
        ('https', '/maintenance/health', 200),
        ('https', '/maintenance/mcp', 401),
        ('https', '/.git/config', 404),
        ('https', '/.env', 404),
    ]:
        try:
            response = opener.open(scheme+'://'+host+path, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read(32768)
            assert response.code == expected, (path, response.code, expected)
            assert b'Directory listing' not in body
            assert 'Python' not in response.headers.get('Server', '')
            if scheme == 'http' and expected == 308:
                assert response.headers['Location'].startswith('https://'+host+'/')
            if scheme == 'https':
                assert response.headers.get('X-Content-Type-Options') == 'nosniff'
            results.append({'path': scheme+'://'+host+path, 'status': response.code})
    return {'passed': True, 'checks': results}


if __name__ == '__main__':
    print(json.dumps(check(), indent=2))

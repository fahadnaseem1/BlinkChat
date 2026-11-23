#!/usr/bin/env python3
"""Check the hosted HTTP configuration; keep guest credentials only in process memory."""

import argparse
import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookies import SimpleCookie


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://localhost:18080')
    parser.add_argument('--origin', default='https://blinkchat-ci.invalid')
    parser.add_argument('--restart-container', help='Restart this disposable Docker test container')
    args = parser.parse_args()
    cookies = {}
    cookie_flags = {}
    origin = urllib.parse.urlsplit(args.origin)

    def request(path, method='GET', body=None, extra_headers=None, expected=200):
        # Emulate the trusted HTTPS reverse proxy while using an isolated loopback port.
        headers = {
            'X-Forwarded-Proto': 'https',
            'X-Forwarded-Host': origin.netloc,
            'Origin': args.origin,
            'Cookie': '; '.join(f'{key}={value}' for key, value in cookies.items()),
        }
        if extra_headers:
            headers.update(extra_headers)
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body).encode()
        req = urllib.request.Request(args.url.rstrip('/') + path, data=data, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            assert response.status == expected, f'{method} {path}: expected HTTP {expected}, got {response.status}'
            for header in response.headers.get_all('Set-Cookie', []):
                parsed = SimpleCookie()
                parsed.load(header)
                for key, cookie in parsed.items():
                    cookies[key] = cookie.value
                    cookie_flags[key] = {
                        'secure': bool(cookie['secure']),
                        'http_only': bool(cookie['httponly']),
                        'same_site': cookie['samesite'].lower(),
                    }
            content = response.read()
            return json.loads(content) if content else None

    def wait_for_health():
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                if request('/api/health') == {'status': 'ok'}:
                    return
            except (OSError, urllib.error.URLError, AssertionError):
                pass
            time.sleep(0.5)
        raise AssertionError('Hosted service did not become healthy within 90 seconds')

    def csrf_headers():
        csrf = request('/api/csrf')
        return {csrf['headerName']: csrf['token']}

    wait_for_health()
    headers = csrf_headers()
    request('/api/guests', 'POST', {'displayName': 'Deployment check'}, expected=403)
    guest = request('/api/guests', 'POST', {'displayName': 'Deployment check'}, headers)
    for key in ('BLINK_GUEST', 'JSESSIONID'):
        flags = cookie_flags[key]
        assert flags['secure'] and flags['http_only'] and flags['same_site'] == 'strict', f'{key} must use secure hosted cookie flags'
    created = request('/api/rooms', 'POST', {'title': 'Deployment check', 'ttlSeconds': 60}, headers)
    room_id = created['room']['id']
    print('PASS: hosted health, forwarded HTTPS, secure cookies, CSRF, and database writes')

    if args.restart_container:
        subprocess.run(
            ['docker', 'exec', args.restart_container, 'sh', '-c',
             'test "$(stat -c %u /proc/1)" = 10001 && test -s /data/blinkchat/blinkchat.mv.db'],
            check=True,
        )
        subprocess.run(['docker', 'restart', args.restart_container], check=True, stdout=subprocess.DEVNULL)
        # Servlet CSRF sessions are in memory; the independent guest credential is durable.
        cookies.pop('JSESSIONID', None)
        wait_for_health()
        recovered = request('/api/me')
        assert recovered['id'] == guest['id'], 'Guest identity must survive a hosted restart'
        rooms = request('/api/rooms')
        assert any(room['id'] == room_id for room in rooms), 'Room must survive a hosted restart'
        headers = csrf_headers()
        print('PASS: Java runs as UID 10001; H2 writes under the volume; guest and room survive restart')

    request(f'/api/rooms/{room_id}/close', 'POST', extra_headers=headers)
    print('PASS: smoke-test room cleaned up')


if __name__ == '__main__':
    main()

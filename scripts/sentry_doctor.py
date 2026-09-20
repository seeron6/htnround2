"""Is Sentry actually on? One command, checked end to end, no guessing from a config file.

    .venv/bin/python scripts/sentry_doctor.py                  # check everything
    .venv/bin/python scripts/sentry_doctor.py --dsn <DSN>      # save the DSN (0600), then check
    .venv/bin/python scripts/sentry_doctor.py --error          # also send one test error

What it checks, in the order things break:
  1. a DSN exists (environment, or .local/secrets/sentry.json) and is well formed
  2. Sentry accepts it: one real envelope is posted and the HTTP answer is read
  3. sentry-sdk is installed in BOTH interpreters, and each sends a trace + log + metric through
     sponsor_obs.py, the same module the services use
  4. each RUNNING service has Sentry on. They read the DSN once, at start-up, so a service started
     before the DSN was saved is still dark: it answers without an X-Sentry-Trace-Id header
  5. the browser will get the DSN, and @sentry/browser is installed

The DSN's key is never printed. Exit code 0 only when everything that is running is reporting.
"""

import argparse, json, os, re, subprocess, sys, time, uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SECRETS = ROOT / '.local/secrets'
DSN = re.compile(r'^(https?)://([^:@/]+)(?::[^@/]*)?@([^/]+)/(?:.*/)?(\d+)$')
INTERPRETERS = {
    'capture (.venv)': ROOT / '.venv/bin/python',
    'physics (.local/newton-env)': ROOT / '.local/newton-env/bin/python',
}
ORIGIN = 'http://127.0.0.1:5173'
results = []


def say(ok, what, detail='', fix=None):
    results.append(ok)
    mark = {True: 'PASS', False: 'FAIL', None: 'SKIP'}[ok]
    print('[%s] %s%s' % (mark, what, (': ' + detail) if detail else ''))
    if fix and ok is False:
        print('       -> ' + fix)


def saved():
    try:
        return json.loads((SECRETS / 'sentry.json').read_text())
    except (OSError, ValueError):
        return {}


def save(dsn, browser_dsn=None, environment=None):
    if not DSN.match(dsn) or (browser_dsn and not DSN.match(browser_dsn)):
        sys.exit(
            'That is not a DSN. It looks like https://<key>@o<org>.ingest.sentry.io/<project>'
        )
    SECRETS.mkdir(parents=True, exist_ok=True)
    os.chmod(SECRETS, 0o700)
    data = {
        **saved(),
        'pythonDsn': dsn,
        'browserDsn': browser_dsn or dsn,
        'environment': environment or saved().get('environment') or 'hackathon',
    }
    tmp = SECRETS / 'sentry.tmp'
    # Created private; never widened, even briefly.
    with os.fdopen(
        os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w'
    ) as out:
        json.dump(data, out)
    tmp.replace(SECRETS / 'sentry.json')
    print('Saved .local/secrets/sentry.json (0600, git-ignored).')


def ingest_accepts(dsn):
    """Post one small transaction straight to the ingest endpoint and read the answer. The SDKs
    send in the background and never say whether it was accepted; this does."""
    scheme, key, host, project = DSN.match(dsn).groups()
    now, trace, span, event = (
        time.time(),
        uuid.uuid4().hex,
        uuid.uuid4().hex[:16],
        uuid.uuid4().hex,
    )
    body = '\n'.join(
        json.dumps(part)
        for part in (
            {
                'event_id': event,
                'sent_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            },
            {'type': 'transaction'},
            {
                'type': 'transaction',
                'event_id': event,
                'transaction': 'sentry_doctor.ingest_check',
                'platform': 'python',
                'environment': saved().get('environment') or 'hackathon',
                'start_timestamp': now - 0.01,
                'timestamp': now,
                'contexts': {
                    'trace': {'trace_id': trace, 'span_id': span, 'op': 'doctor'}
                },
            },
        )
    )
    request = Request(
        '%s://%s/api/%s/envelope/' % (scheme, host, project),
        data=body.encode() + b'\n',
        headers={
            'Content-Type': 'application/x-sentry-envelope',
            'X-Sentry-Auth': 'Sentry sentry_version=7, sentry_client=punching-face-doctor/1.0, '
            'sentry_key=' + key,
        },
    )
    try:
        with urlopen(request, timeout=12) as response:
            return response.status == 200, 'HTTP %d from %s, project %s' % (
                response.status,
                host,
                project,
            )
    except HTTPError as e:
        why = {
            401: 'the key is wrong',
            403: 'the key is disabled or the project is gone',
            429: 'rate limited, or the quota is spent',
        }
        return False, 'HTTP %d from %s (%s)' % (
            e.code,
            host,
            why.get(e.code, e.read(200).decode('utf-8', 'replace')),
        )
    except (URLError, OSError) as e:
        return False, 'could not reach %s (%s)' % (host, getattr(e, 'reason', e))


PROBE = r'''
import sys, json
sys.path.insert(0, %r)
import sponsor_obs
if not sponsor_obs.sentry_sdk:
    print(json.dumps({'sdk': None})); raise SystemExit
import sentry_sdk
on = sponsor_obs.init('doctor')
out = {'sdk': sentry_sdk.VERSION, 'on': on, 'logs': bool(sponsor_obs.sentry_logs), 'release': sponsor_obs.release()}
if on:
    who = 'python %%d.%%d' %% sys.version_info[:2]
    with sentry_sdk.start_transaction(op='doctor', name='sentry_doctor.wiring') as check:
        with sponsor_obs.stage('doctor.step', 'a child span'):
            sponsor_obs.metric('doctor.check', 1, None, interpreter=who)
        if %r:
            sponsor_obs.capture(RuntimeError('sentry_doctor: test error from ' + who + ', safe to resolve'))
        out['trace'] = check.trace_id
    if sponsor_obs.sentry_logs:
        sponsor_obs.sentry_logs.info('sentry_doctor: logs reach Sentry', attributes={'interpreter': who})
    sentry_sdk.flush(timeout=8)
print(json.dumps(out))
'''


def probe(python, error):
    if not python.exists():
        return None, 'interpreter not found'
    run = subprocess.run(
        [str(python), '-c', PROBE % (str(ROOT), bool(error))],
        capture_output=True,
        text=True,
        timeout=90,
        cwd=str(ROOT),
    )
    try:
        return json.loads(run.stdout.strip().splitlines()[-1]), run.stderr[-300:]
    except (ValueError, IndexError):
        return None, (run.stderr or run.stdout)[-300:]


def header_of(url, data=None):
    """(answered, trace id header). POSTs are shaped to be refused harmlessly."""
    request = Request(
        url,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'Origin': ORIGIN, 'Content-Type': 'application/json'},
    )
    try:
        with urlopen(request, timeout=5) as response:
            return True, response.headers.get('X-Sentry-Trace-Id'), response.read(20000)
    except HTTPError as e:
        return True, e.headers.get('X-Sentry-Trace-Id'), b''
    except (URLError, OSError):
        return False, None, b''


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument(
        '--dsn', help='save this DSN for the Python services (and the browser)'
    )
    parser.add_argument(
        '--browser-dsn', help='a second project for the browser, if you made one'
    )
    parser.add_argument('--environment', help='default: hackathon')
    parser.add_argument(
        '--error', action='store_true', help='also send one test error per interpreter'
    )
    args = parser.parse_args()
    if args.dsn:
        save(
            args.dsn.strip(), (args.browser_dsn or '').strip() or None, args.environment
        )

    file = saved()
    dsn = (
        os.environ.get('SENTRY_DSN') or file.get('pythonDsn') or file.get('browserDsn')
    )
    browser = os.environ.get('SENTRY_DSN_BROWSER') or file.get('browserDsn') or dsn
    print('Sentry doctor\n')
    if not dsn:
        say(
            False,
            'A DSN is configured',
            'none in SENTRY_DSN or .local/secrets/sentry.json, so every Sentry call in this repo is a no-op',
            'sentry.io -> your project -> Settings -> Client Keys (DSN), then: '
            '.venv/bin/python scripts/sentry_doctor.py --dsn <DSN>',
        )
    elif not DSN.match(dsn):
        say(False, 'A DSN is configured', 'it is not shaped like a DSN')
        dsn = None
    else:
        _, _, host, project = DSN.match(dsn).groups()
        say(
            True,
            'A DSN is configured',
            'project %s at %s (%s)'
            % (
                project,
                host,
                'environment' if os.environ.get('SENTRY_DSN') else 'sentry.json',
            ),
        )
        ok, detail = ingest_accepts(dsn)
        say(ok, 'Sentry accepts it', detail)
        if browser and browser != dsn and DSN.match(browser):
            ok, detail = ingest_accepts(browser)
            say(ok, 'Sentry accepts the browser DSN', detail)

    for name, python in INTERPRETERS.items():
        out, noise = probe(python, args.error)
        if not out:
            say(
                False,
                'sentry-sdk in ' + name,
                noise.strip().splitlines()[-1] if noise.strip() else 'no answer',
            )
        elif not out.get('sdk'):
            say(
                False,
                'sentry-sdk in ' + name,
                'not installed',
                '%s -m pip install -r requirements-sponsors.txt'
                % python.relative_to(ROOT),
            )
        elif not dsn:
            say(
                None,
                'sentry-sdk %s in %s' % (out['sdk'], name),
                'installed; nothing sent without a DSN',
            )
        else:
            say(
                bool(out.get('on') and out.get('trace')),
                'sentry-sdk %s in %s sent a trace, a log and a metric'
                % (out['sdk'], name),
                'trace %s, release %s' % (out.get('trace'), out.get('release')),
            )

    print()
    services = [
        (
            'API + pipeline (server.py :5174)',
            'http://127.0.0.1:5174/api/health',
            None,
            'npm run dev',
        ),
        (
            'Newton physics (physics_server.py :5175)',
            'http://127.0.0.1:5175/physics/close',
            {'session': 'sentry-doctor'},
            'npm run dev',
        ),
        (
            'Face relay (sponsor_server.py :5176)',
            'http://127.0.0.1:5176/sponsors/config',
            None,
            'npm run sponsors',
        ),
    ]
    config = {}
    for name, url, data, restart in services:
        up, trace, body = header_of(url, data)
        if not up:
            say(None, name, 'not running')
            continue
        if url.endswith('/sponsors/config'):
            try:
                config = json.loads(body).get('sentry') or {}
            except ValueError:
                pass
        say(
            bool(trace),
            name,
            (
                'reporting (this check was trace %s)' % trace
                if trace
                else 'running WITHOUT Sentry'
            ),
            'it read its settings before the DSN existed, or runs older code. Restart it: '
            + restart,
        )

    print()
    try:
        version = json.loads(
            (ROOT / 'node_modules/@sentry/browser/package.json').read_text()
        )['version']
        say(True, '@sentry/browser is installed', version)
    except (OSError, ValueError, KeyError):
        say(False, '@sentry/browser is installed', 'missing', 'npm install')
    if config:
        say(
            bool(config.get('dsn')),
            'The page will get a DSN from the relay',
            (
                'release %s, environment %s'
                % (config.get('release'), config.get('environment'))
                if config.get('dsn')
                else 'the relay has none to give'
            ),
            'save a DSN (see above); the relay reads it per request, so only the page needs a reload',
        )
    elif browser:
        say(
            None,
            'The page will get a DSN from the relay',
            'the relay is not running, so the page cannot ask',
        )

    failed = results.count(False)
    print(
        '\n%s'
        % (
            'ALL PASS: Sentry is on.'
            if not failed
            else '%d problem%s. Sentry is NOT fully on.'
            % (failed, '' if failed == 1 else 's')
        )
    )
    if dsn and not failed:
        print(
            'Look in Sentry -> Explore -> Traces for "sentry_doctor.wiring" (environment: %s).'
            % (file.get('environment') or 'hackathon')
        )
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())

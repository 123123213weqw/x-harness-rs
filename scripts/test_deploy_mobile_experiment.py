"""Offline tests: no SSH, systemd execution, credential reads or production writes."""
import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import re
import tempfile
import unittest
import subprocess
from unittest import mock

spec = importlib.util.spec_from_file_location('mobile_deployment', Path(__file__).with_name('deploy-mobile-experiment.py'))
deploy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = deploy
spec.loader.exec_module(deploy)

CONFIG = b'''pid /home/xs/services/existing/nginx.pid;
events {}
http {
    map $request_method:$uri $xh_route {
        default deny;
        "GET:/" bff;
        "HEAD:/" bff;
        "GET:/plugins/catalog.json" bff;
        "POST:/identity/device/authorize" idp;
        "POST:/api/inference" bff;
    }
    # quoted brace below must not confuse the block parser
    log_format custom "brace { } ; ignored";
    server {
        listen 8443 ssl;
        server_name engine.xxdevs.com;
        if ($xh_route = deny) { return 404; }
        ssl_certificate /existing/tls/cert.pem;
        ssl_certificate_key /existing/tls/private-key.pem;
        location /downloads { alias /existing/downloads/; }
        location /updates { proxy_pass http://127.0.0.1:3010; }
        location /plugins { alias /existing/plugins/; }
        location /identity { proxy_pass http://127.0.0.1:3020; }
        location /api/inference { proxy_pass http://127.0.0.1:3030; }
        location / { root /existing/frontend/; }
    }
}
'''


class DeploymentTests(unittest.TestCase):
    def test_default_dry_run_is_zero_side_effect_no_secret_creation(self):
        with mock.patch.object(deploy.subprocess, 'run', side_effect=AssertionError('no commands')), mock.patch.object(deploy.secrets, 'token_hex', side_effect=AssertionError('no secrets')), mock.patch.object(Path, 'read_bytes', side_effect=AssertionError('no file reads')), mock.patch.object(Path, 'mkdir', side_effect=AssertionError('no writes')):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(deploy.main([]), 0)
            plan = json.loads(output.getvalue())
        self.assertEqual(plan['mode'], 'dry-run')
        self.assertFalse(plan['writes_files'])
        self.assertFalse(plan['executes_ssh'])
        self.assertEqual(plan['model'], 'unconfigured')
        self.assertFalse(plan['inherited_keys'])
        self.assertNotIn('31369', plan['route_template'])

    def test_rollback_is_dry_run_without_apply(self):
        with mock.patch.object(deploy, 'rollback', side_effect=AssertionError('no apply')):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(deploy.main(['--rollback']), 0)
            self.assertEqual(json.loads(output.getvalue())['mode'], 'dry-run-rollback')

    def test_apply_is_refused_on_this_machine_without_network(self):
        with mock.patch.object(deploy, 'validate_machine', side_effect=deploy.DeployError('not server')), mock.patch.object(deploy.subprocess, 'run', side_effect=AssertionError('no network/commands')):
            output = io.StringIO()
            with contextlib.redirect_stderr(output):
                self.assertEqual(deploy.main(['--apply']), 1)
            self.assertEqual(json.loads(output.getvalue())['status'], 'failed_closed')

    def test_route_addition_preserves_every_existing_byte_and_tls(self):
        candidate = deploy.add_routes(CONFIG)
        insertion = ('\n' + '\n'.join('    ' + line for line in deploy.route_template().splitlines()) + '\n').encode()
        self.assertEqual(candidate.replace(insertion, b'', 1).replace(deploy.mobile_method_insertion(), b'', 1), CONFIG)
        self.assertIn(b'location ^~ /remote-control/ { access_log off; return 404; }', candidate)
        self.assertEqual(candidate.count(b'ssl_certificate_key'), 1)
        self.assertNotIn(b'31369', candidate)
        self.assertNotIn(b'proxy_pass http://127.0.0.1:31368/api/respond', candidate)
        for path in (b'/downloads', b'/updates', b'/plugins', b'/identity', b'/api/inference'):
            self.assertEqual(candidate.count(b'location ' + path), CONFIG.count(b'location ' + path))

    def test_standalone_method_allowlist_extends_real_server_gate_without_old_edits(self):
        def route_map(data):
            scopes = deploy.nginx_scopes(data.decode())
            http = next(scope for scope in scopes.children if scope.header == ('http',))
            return next(scope for scope in http.children if scope.header == ('map', '$request_method:$uri', '$xh_route'))
        before = route_map(CONFIG).statements
        patched = deploy.add_mobile_method_allowlist(CONFIG)
        self.assertEqual(patched.replace(deploy.mobile_method_insertion(), b'', 1), CONFIG)
        after = route_map(patched).statements
        expected = [(deploy.mobile_method_pattern(method, path), 'mobile') for method, path in deploy.mobile_method_entries()]
        self.assertEqual(after, before + expected)
        self.assertEqual(len(expected), 14)
        self.assertEqual(set(method for method, _ in deploy.mobile_method_entries()), {'GET', 'HEAD', 'POST'})
        for rejected in ('GET:/remote-control/api/mobile/action', 'GET:/remote-control/api/mobile/pair', 'POST:/remote-control/', 'HEAD:/remote-control/api/mobile/host', 'GET:/remote-control/healthz', 'DELETE:/remote-control/api/mobile/action', 'OPTIONS:/remote-control/api/mobile/pair'):
            self.assertFalse(any(re.fullmatch(key[1:], rejected) for key, value in expected if value == 'mobile'))
        self.assertEqual(after.count(('default', 'deny')), 1)
        self.assertIn(b'if ($xh_route = deny) { return 404; }', patched)
        # Root's already-applied location-only config can be finalized using
        # this helper alone, without touching its installed location bytes.
        full = deploy.add_routes(CONFIG)
        location_only = full.replace(deploy.mobile_method_insertion(), b'', 1)
        self.assertEqual(deploy.add_mobile_method_allowlist(location_only), full)

    def test_method_allowlist_rejects_missing_duplicate_or_non_deny_map(self):
        cases = (
            CONFIG.replace(b'$request_method:$uri $xh_route', b'$request_method:$uri $other_route'),
            CONFIG.replace(b'default deny;', b'default bff;'),
            CONFIG.replace(b'default deny;', b''),
            CONFIG.replace(b'default deny;', b'default deny; default deny;'),
            CONFIG.replace(b'    server {', b'    map $request_method:$uri $xh_route { default deny; }\n    server {', 1),
        )
        for original in cases:
            with self.assertRaises(deploy.DeployError):
                deploy.add_mobile_method_allowlist(original)

    def test_method_allowlist_rejects_key_conflicts_and_duplicate_owner_marker(self):
        for key in (b'GET:/remote-control/', b'POST:/remote-control/api/mobile/action', b'get:/Remote-Control/App.js', b'~^GET:/remote-control/app[.]js$', b'~*^GET:/remote-control/app[.]js$', b'~^GET:/remote-control/app.js$'):
            original = CONFIG.replace(b'default deny;', b'default deny; "' + key + b'" bff;')
            with self.assertRaises(deploy.DeployError):
                deploy.add_mobile_method_allowlist(original)
        for marker in (deploy.ALLOWLIST_BEGIN, deploy.ALLOWLIST_END):
            with self.assertRaises(deploy.DeployError):
                deploy.add_mobile_method_allowlist(CONFIG + marker.encode())
        with self.assertRaises(deploy.DeployError):
            deploy.add_mobile_method_allowlist(deploy.add_mobile_method_allowlist(CONFIG))

    def test_mobile_gate_patterns_are_case_sensitive_anchored_and_dot_literal(self):
        patterns = [deploy.mobile_method_pattern(method, path) for method, path in deploy.mobile_method_entries()]
        self.assertEqual(len(patterns), 14)
        for method, path in deploy.mobile_method_entries():
            self.assertTrue(any(re.fullmatch(pattern[1:], method + ':' + path) for pattern in patterns))
        rejected = (
            'GET:/REMOTE-CONTROL/', 'GET:/remote-control/APP.JS',
            'get:/remote-control/', 'head:/remote-control/app.js',
            'post:/remote-control/api/mobile/action',
            'GET:/remote-control/appXjs', 'GET:/remote-control/indexXhtml',
            'GET:/remote-control/styleXcss', 'GET:/remote-control/app.js/extra',
            'xGET:/remote-control/', 'GET:/remote-control/app.js;extra',
            'HEAD:/remote-control/api/mobile/host',
            'POST:/remote-control/api/mobile/host',
        )
        for candidate in rejected:
            self.assertFalse(any(re.fullmatch(pattern[1:], candidate) for pattern in patterns), candidate)
        template = deploy.mobile_method_allowlist_template()
        self.assertIn('"~^GET:/remote-control/app[.]js$" mobile;', template)
        self.assertNotIn('~*', template)
        self.assertNotIn('\\.', template)

    def test_route_owner_conflict_or_existing_prefix_fails_closed(self):
        for original in (CONFIG.replace(b'location / {', b'location /remote-control/ {'), CONFIG + deploy.BEGIN.encode(), CONFIG + deploy.END.encode()):
            with self.assertRaises(deploy.DeployError):
                deploy.add_routes(original)
        with self.assertRaises(deploy.DeployError):
            deploy.add_routes(deploy.add_routes(CONFIG))

    def test_server_target_must_be_unique_exact_domain_and_port(self):
        for original in (CONFIG.replace(b'8443 ssl', b'443 ssl'), CONFIG.replace(b'engine.xxdevs.com', b'other.example.com'), CONFIG.replace(b'    server {', b'    server { listen 8443 ssl; server_name engine.xxdevs.com; }\n    server {', 1)):
            with self.assertRaises(deploy.DeployError):
                deploy.add_routes(original)
        self.assertIn(deploy.BEGIN.encode(), deploy.add_routes(CONFIG.replace(b'listen 8443 ssl', b'listen 127.0.0.1:8443 ssl')))

    def test_lexer_handles_comments_quotes_and_rejects_unbalanced(self):
        valid = CONFIG.replace(b'log_format custom', b'# { } ; server {\n    log_format custom')
        self.assertIn(deploy.BEGIN.encode(), deploy.add_routes(valid))
        for bad in (b'http { server {', b'http { log_format x "bad; }', b'}', b'http { stray }'):
            with self.assertRaises(deploy.DeployError):
                deploy.nginx_scopes(bad.decode())

    def test_routes_are_exact_protocol_and_three_static_assets(self):
        route = deploy.route_template()
        for path in ('pair', 'action', 'logout', 'host'):
            self.assertIn('location = /remote-control/api/mobile/' + path, route)
        for name in ('app.js', 'style.css', 'index.html'):
            self.assertIn('location = /remote-control/' + name, route)
        self.assertNotIn('/remote-control/api/remote-control/manage', route)
        self.assertNotIn('/remote-control/healthz', route)
        self.assertIn('proxy_set_header Connection "upgrade";', route)
        self.assertEqual(route.count('access_log off;'), route.count('location '))

    def test_public_slash_redirect_cannot_leak_internal_tls_8443(self):
        route = deploy.route_template()
        self.assertIn('return 302 https://engine.xxdevs.com/remote-control/;', route)
        self.assertNotIn('return 302 /remote-control/;', route)
        self.assertNotIn(':8443', route)

    def test_units_are_isolated_and_never_restart_edge_or_enable_linger(self):
        units = deploy.unit_templates()
        self.assertEqual(set(units), {deploy.RELAY_UNIT, deploy.HOST_UNIT})
        for text in units.values():
            self.assertTrue(text.startswith('# ' + deploy.OWNER))
            self.assertIn('/usr/bin/env -i', text)
            self.assertIn('UMask=0077', text)
            self.assertNotIn('sudo', text)
            self.assertNotIn('loginctl', text)
            self.assertNotIn(deploy.EDGE_UNIT, text)
            self.assertNotIn('EnvironmentFile', text)
        relay = units[deploy.RELAY_UNIT]
        self.assertIn('--bind 127.0.0.1:31368', relay)
        self.assertIn('--public-origin https://engine.xxdevs.com', relay)
        self.assertNotIn('--allow-loopback-http', relay)
        self.assertIn('launch-host.py', units[deploy.HOST_UNIT])

    def test_host_env_has_no_provider_credentials_and_closed_keys(self):
        env = deploy.host_environment(deploy.ROOT, 'd' * 64, 'h' * 64)
        self.assertEqual(set(env), deploy.ENV_KEYS - deploy.OPTIONAL_ENV_KEYS)
        self.assertEqual(env['XHARNESS_MODEL'], 'unconfigured')
        self.assertEqual(env['XHARNESS_API_KEY'], '')
        self.assertEqual(env['OPENAI_API_KEY'], '')
        self.assertNotEqual(env['XHARNESS_DESKTOP_TOKEN'], env['XHARNESS_MOBILE_HOST_KEY'])
        self.assertEqual(env['XHARNESS_BIND'], '127.0.0.1:31369')
        self.assertEqual(env['XHARNESS_MOBILE_ALLOW_LOOPBACK'], 'enabled')
        self.assertEqual(env['XHARNESS_MOBILE_PUBLIC_URL'], deploy.PUBLIC_ORIGIN + '/remote-control/')
        self.assertNotIn('DBUS_SESSION_BUS_ADDRESS', env)
        self.assertNotIn('SSH_AUTH_SOCK', env)
        self.assertNotIn('XHARNESS_WEB_DIST', env)
        encoded = deploy.environment_bytes(env)
        self.assertIn(b'OPENAI_API_KEY=\n', encoded)
        with self.assertRaises(deploy.DeployError):
            deploy.environment_bytes({**env, 'INHERITED_KEY': 'oops'})
        with self.assertRaises(deploy.DeployError):
            deploy.environment_bytes({**env, 'XHARNESS_MODEL': 'x\nKEY=bad'})

    def test_optional_desktop_settings_stays_loopback_and_never_uses_empty_path(self):
        env = deploy.host_environment(deploy.ROOT, 'd' * 64, 'h' * 64, deploy.ROOT / 'desktop-ui')
        self.assertEqual(env['XHARNESS_WEB_DIST'], str(deploy.ROOT / 'desktop-ui'))
        self.assertIn(b'XHARNESS_WEB_DIST=/home/xs/services/', deploy.environment_bytes(env))
        with self.assertRaises(deploy.DeployError):
            deploy.environment_bytes({**env, 'XHARNESS_WEB_DIST': ''})
        with self.assertRaises(deploy.DeployError):
            deploy.host_environment(deploy.ROOT, 'd' * 64, 'h' * 64, Path('.'))
        plan = deploy.redacted_plan(deploy.parse_args(['--desktop-static-dir', '/supplied/ui/dist']))
        self.assertEqual(plan['desktop_static'], str(deploy.ROOT / 'desktop-ui'))
        self.assertNotIn('31369', plan['route_template'])

    def test_desktop_static_copy_rejects_sensitive_files_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / 'source', root / 'target'
            source.mkdir()
            (source / 'index.html').write_text('desktop')
            (source / 'app.js').write_text('settings')
            deploy.install_desktop_static(source, target)
            self.assertEqual((target / 'index.html').read_text(), 'desktop')
            (source / '.env').write_text('do-not-copy')
            with self.assertRaises(deploy.DeployError):
                deploy.install_desktop_static(source, target)
            (source / '.env').unlink()
            (source / 'linked.js').symlink_to(source / 'app.js')
            with self.assertRaises(deploy.DeployError):
                deploy.install_desktop_static(source, target)

    def test_launcher_environment_is_not_inherited_and_is_syntactically_valid(self):
        text = deploy.launcher_template()
        compile(text, '<generated-launcher>', 'exec')
        self.assertNotIn('os.environ', text)
        self.assertIn('os.execve', text)
        self.assertIn('config/host.env', text)
        self.assertNotIn('--desktop-token', text)
        self.assertNotIn('OPENAI_API_KEY=', text)

    def test_cas_writes_only_on_exact_current_digest_and_preserves_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'nginx.conf'
            path.write_bytes(CONFIG)
            path.chmod(0o600)
            candidate = deploy.add_routes(CONFIG)
            with self.assertRaises(deploy.DeployError):
                deploy.cas_write(path, '0' * 64, candidate)
            self.assertEqual(path.read_bytes(), CONFIG)
            deploy.cas_write(path, deploy.digest(CONFIG), candidate)
            self.assertEqual(path.read_bytes(), candidate)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(deploy.DeployError):
                deploy.cas_write(path, deploy.digest(CONFIG), CONFIG)

    def test_symlink_config_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            actual = Path(directory) / 'actual'
            actual.write_bytes(CONFIG)
            link = Path(directory) / 'link'
            link.symlink_to(actual)
            with self.assertRaises(deploy.DeployError):
                deploy.cas_write(link, deploy.digest(CONFIG), b'bad')
            self.assertEqual(actual.read_bytes(), CONFIG)

    def test_owner_marker_and_directory_permissions_are_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'experiment'
            deploy.ensure_owner(root, create=True)
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            self.assertEqual((root / '.owner').read_text(), deploy.OWNER + '\n')
            (root / '.owner').write_text('other-owner\n')
            with self.assertRaises(deploy.DeployError):
                deploy.ensure_owner(root)

    def test_hash_change_only_requires_review_not_rollback(self):
        before = [{'url': 'https://engine.xxdevs.com/', 'status': 200, 'body_sha256': 'a'}]
        after = [{'url': 'https://engine.xxdevs.com/', 'status': 200, 'body_sha256': 'b'}]
        result = deploy.comparison(before, after)
        self.assertEqual(result['http_degradation'], [])
        self.assertEqual(result['body_changed_review_required'], [before[0]['url']])
        after[0]['status'] = 502
        self.assertEqual(deploy.comparison(before, after)['http_degradation'], [before[0]['url']])
        after[0] = {'url': before[0]['url'], 'status': 0, 'error': 'network_unavailable'}
        self.assertEqual(deploy.comparison(before, after)['http_degradation'], [])
        self.assertEqual(deploy.comparison(before, after)['unavailable_review_required'], [before[0]['url']])

    def test_smoke_rejects_secret_query_external_origin_and_new_routes(self):
        for url in ('http://engine.xxdevs.com/', 'https://evil.example/', 'https://user:secret@engine.xxdevs.com/', 'https://engine.xxdevs.com/?token=secret', 'https://engine.xxdevs.com/#secret', 'https://engine.xxdevs.com:8443/', 'https://engine.xxdevs.com/remote-control/'):
            with mock.patch.object(deploy.urllib.request, 'urlopen', side_effect=AssertionError('no network')):
                with self.assertRaises(deploy.DeployError):
                    deploy.smoke(url)

    def test_nginx_test_is_before_reload_in_apply_and_no_restart_edge(self):
        # Source assertion complements pure tests without running any service.
        source = Path(deploy.__file__).read_text()
        self.assertIn("command(['systemctl', '--user', 'reload', EDGE_UNIT])", source)
        self.assertNotIn("'restart', EDGE_UNIT", source)
        self.assertNotIn('enable-linger', source)
        self.assertNotIn('os.environ.copy()', source)
        self.assertNotIn('ps -', source)

    def test_edge_reload_uses_only_closed_capability_and_known_scope(self):
        for answer, expected in ((b'yes\n', 'systemd_reload'), (b'no\n', 'nginx_signal')):
            with mock.patch.object(deploy, 'known_command', return_value=subprocess.CompletedProcess([], 0, answer, b'')) as command:
                self.assertEqual(deploy.edge_reload_mode(), expected)
                self.assertEqual(command.call_args.args[0], ['systemctl', '--user', 'show', '--property=CanReload', '--value', deploy.EDGE_UNIT])
        for result in (subprocess.CompletedProcess([], 1, b'', b''), subprocess.CompletedProcess([], 0, b'unknown', b'')):
            with mock.patch.object(deploy, 'known_command', return_value=result):
                with self.assertRaises(deploy.DeployError):
                    deploy.edge_reload_mode()

    def test_no_exec_reload_falls_back_to_explicit_nginx_graceful_signal(self):
        with mock.patch.object(deploy, 'command') as command:
            deploy.edge_reload('nginx_signal')
            self.assertEqual(command.call_args.args[0], ['/usr/sbin/nginx', '-s', 'reload', '-p', str(deploy.EDGE_CONFIG.parent) + '/', '-c', str(deploy.EDGE_CONFIG)])
            self.assertNotIn('restart', command.call_args.args[0])
            deploy.edge_reload('systemd_reload')
            self.assertEqual(command.call_args.args[0], ['systemctl', '--user', 'reload', deploy.EDGE_UNIT])
            with self.assertRaises(deploy.DeployError):
                deploy.edge_reload('restart')

    def test_warmup_requires_exact_host_addr_and_authenticated_host_count(self):
        health = {'ok': True, 'connected_hosts': 1}
        self.assertTrue(deploy.warmup_ready('127.0.0.1:31369', health))
        self.assertTrue(deploy.warmup_ready('127.0.0.1:31369\n', health))
        for address in ('127.0.0.1:31368', '0.0.0.0:31369', '127.0.0.1:31369 extra', ''):
            self.assertFalse(deploy.warmup_ready(address, health))
        for response in ({'ok': True}, {'ok': True, 'connected_hosts': 0}, {'ok': False, 'connected_hosts': 1}, {'ok': True, 'connected_hosts': True}, {'ok': True, 'connected_hosts': '1'}):
            self.assertFalse(deploy.warmup_ready('127.0.0.1:31369', response))

    def test_candidate_validation_preserves_nginx_conf_directory_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            edge = Path(directory) / 'edge'
            edge.mkdir()
            actual = edge / 'nginx.conf'
            actual.write_bytes(CONFIG)
            paths = []
            def validated(binary, path, prefix):
                self.assertEqual(binary, '/usr/sbin/nginx')
                self.assertEqual(path.parent, actual.parent)
                self.assertEqual(prefix, actual.parent)
                self.assertNotEqual(path, actual)
                self.assertTrue(path.name.startswith('.xharness-mobile-validate-'))
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(path.read_bytes(), CONFIG)
                paths.append(path)
            with mock.patch.object(deploy, 'nginx_test', side_effect=validated):
                deploy.nginx_test_bytes('/usr/sbin/nginx', CONFIG, actual, actual.parent)
            self.assertFalse(paths[0].exists())
            self.assertEqual(actual.read_bytes(), CONFIG)
            with mock.patch.object(deploy, 'nginx_test', side_effect=deploy.DeployError('invalid candidate')):
                with self.assertRaises(deploy.DeployError):
                    deploy.nginx_test_bytes('/usr/sbin/nginx', CONFIG, actual, actual.parent)
            self.assertEqual(list(edge.iterdir()), [actual])

if __name__ == '__main__':
    unittest.main()

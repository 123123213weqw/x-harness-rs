"""Pre-model lab scope check; never part of the production Computer driver.

Titles alone do not identify a trial: old synthetic Edge windows have the same
name. Validate an owned UIA address value on the unique foreground surface.
Missing/ambiguous values fail closed; no input is retried or inferred delivered.
"""
from urllib.parse import urlsplit


class FixtureScopeError(ValueError):
    pass


def _url_identity(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if '://' not in value:
        value = 'http://' + value
    try:
        u = urlsplit(value)
        port = u.port or (80 if u.scheme == 'http' else 443)
    except ValueError:
        return None
    if u.username or u.password or u.fragment or u.scheme not in ('http', 'https'):
        return None
    return u.scheme, u.hostname, port, u.path, u.query


def require_active_fixture(value, expected_url):
    """Accept only independently observed foreground address, not a page event.

    The controlled fixture's other Edit values are empty/product search, never
    URLs. This is a lab oracle, not a general browser address-bar detector.
    """
    if not isinstance(value, dict) or value.get('ok') is not True:
        raise FixtureScopeError('No successful scope observation')
    result = value.get('result') or {}
    active = [s for s in result.get('surfaces', []) if s.get('frontmost') is True]
    if len(active) != 1 or not active[0].get('surface_id'):
        raise FixtureScopeError('No unique foreground surface')
    sid = active[0]['surface_id']
    nodes = (result.get('accessibility') or {}).get('nodes', [])
    addresses = [_url_identity(n.get('value')) for n in nodes
                 if n.get('surface_id') == sid and n.get('role') == 'edit'
                 and n.get('value_state') == 'known']
    addresses = [a for a in addresses if a and a[1] == '10.0.2.2']
    expected = _url_identity(expected_url)
    if expected is None or expected[1] != '10.0.2.2':
        raise FixtureScopeError('Not a disposable fixture origin')
    if len(addresses) != 1 or addresses[0] != expected:
        raise FixtureScopeError('Foreground fixture origin/case mismatch or unavailable; no model admitted')
    return sid

"""Task submission boundary; no provider secret enters the container."""
import json
import urllib.request


def begin_trial(config, base_url, capability):
    if config.get('start_control'):
        request = urllib.request.Request(base_url + '/trial/start', data=b'{}',
            headers={'Authorization': 'Bearer ' + capability, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=10) as response:
            json.load(response)

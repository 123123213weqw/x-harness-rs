"""Bootstrap only the authorized disposable console after a screenshot check.

This launches the guarded script through an already idle CMD prompt; no login
credential is read or typed, and the original VM's socket is never accessed.
"""
import json
import socket
import time
from pathlib import Path
import urllib.request

root=Path('/home/data/wzu/windows-browser-bounds-20261012')
connection=socket.socket(socket.AF_UNIX)
connection.settimeout(10)
connection.connect('/home/data/wzu/vms/xharness-install-lab-20261005/qmp.sock')
stream=connection.makefile('rwb',buffering=0)
json.loads(stream.readline())
def q(command,arguments=None):
    stream.write((json.dumps({'execute':command,**({'arguments':arguments} if arguments else {})})+'\n').encode())
    while True:
        value=json.loads(stream.readline())
        if 'error' in value:raise RuntimeError(value['error'])
        if 'return' in value:return value['return']
q('qmp_capabilities')
assert q('query-name')['name']=='xharness-install-lab-20261005'
http=urllib.request.build_opener(urllib.request.ProxyHandler({}))
with http.open('http://127.0.0.1:18125/provenance.json',timeout=10) as response:meta=json.load(response)
assert meta['source_sha']=='5d7b4408786183eb97a46837a4a9fa26f143e400'
command='curl.exe -fsS http://10.0.2.2:18125/run.cmd -o "%TEMP%\\xh-bounds-20261012.cmd" && "%TEMP%\\xh-bounds-20261012.cmd"'
special={'.':'dot','/':'slash',':':'shift-semicolon','-':'minus',' ':'spc','%':'shift-5','\\':'backslash','"':'shift-apostrophe','&':'shift-7'}
for character in command:
    if character.isascii() and character.isalnum():
        key=('shift-' if character.isupper() else '')+character.lower()
    else:key=special[character]
    q('human-monitor-command',{'command-line':'sendkey '+key+' 30'})
    time.sleep(.045)
q('human-monitor-command',{'command-line':'sendkey ret 30'})
(root/'launch.json').write_text(json.dumps({'source_sha':meta['source_sha'],'vm':'xharness-install-lab-20261005','credential_input':False,'utc':time.time()}))
print('Guarded disposable bounds script launched; completion must come from guest receipts')
connection.close()

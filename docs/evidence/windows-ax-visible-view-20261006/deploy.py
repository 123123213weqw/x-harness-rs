from pathlib import Path
import hashlib, importlib.util, json, os, shutil, sys, time
root=Path('/home/data/wzu/windows-install-artifacts-20261005')
stage=root/'ax-visible-view-20261006'
mode,expected=sys.argv[1:]
assert mode in ('control','experiment')
old=json.loads((root/'browser-latest.json').read_text())
assert old.get('phase')=='finished' and old.get('probe_alive') is False, 'Prior probe is not confirmed exited; refuse redeploy'
assert old.get('operations')==6
provenance=json.loads((stage/'provenance.json').read_text(encoding='utf-8-sig'))
exe=(stage/'computer-probe.exe').read_bytes()
digest=hashlib.sha256(exe).hexdigest()
assert provenance['source_sha']==expected and provenance['executable_sha256']==digest
spec=importlib.util.spec_from_file_location('pe_audit',str(Path.home()/'codex-build/x-harness-rs/ax-visible-view-20261006/scripts/audit-windows-runtime.py'))
audit=importlib.util.module_from_spec(spec);sys.modules[spec.name]=audit;spec.loader.exec_module(audit)
pe=audit.PE(exe);imports=pe.imports()
assert pe.machine==0x8664 and all(not audit.MSVC.match(n) and audit.system(n) for n in imports)
backup=stage/(mode+'-prior-'+str(time.time_ns()));backup.mkdir()
for name in ['computer-probe.exe','computer-provenance.json','guest-shopping.ps1','browser-next.json','browser-latest.json','browser-results.jsonl']:
 if (root/name).exists():shutil.copy2(root/name,backup/name)
files={'computer-probe.exe':exe,'computer-provenance.json':(stage/'provenance.json').read_bytes(),'guest-shopping.ps1':(stage/f'guest-{mode}.ps1').read_bytes(),'browser-next.json':b'{}'}
for name,data in files.items():
 p=root/(name+'.visible-stage');p.write_bytes(data);p.replace(root/name)
report={'source_sha':expected,'mode':mode,'executable_sha256':digest,'imports':imports,'no_dynamic_msvc':True,'bytes':len(exe),'prior_exit_confirmed':True}
(stage/(mode+'-audit.json')).write_text(json.dumps(report,indent=2))
print(json.dumps(report))

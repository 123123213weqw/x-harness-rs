"""Account bridge must never grant embedded guest webviews native credentials."""
import json,pathlib
root=pathlib.Path(__file__).resolve().parents[1]
commands={'status','start','poll','open','finish'}
expected={'allow-desktop-account-'+name for name in commands}
for path in (root/'apps/desktop/src-tauri/capabilities').glob('*.json'):
 data=json.loads(path.read_text());granted=set(p for p in data.get('permissions',[]) if isinstance(p,str)) & expected
 if granted: assert data.get('webviews')==['main'] and granted==expected,path.name
source=(root/'apps/desktop/src-tauri/src/managed_account.rs').read_text()
assert source.count('main_only(&window)?')==len(commands)
assert 'Policy::none()' in source and '65536' in source
assert 'Sha256::digest(verifier.as_bytes())' in source
print('Managed account IPC restricted to main; verifier and bounded no-redirect transport present')

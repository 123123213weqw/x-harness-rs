"""Repack one audited upstream artifact as an optional XHarness plugin.
No builds, installation, network, model calls or dependency changes.
"""
import argparse,base64,gzip,hashlib,io,json,pathlib,zipfile
SOURCE_SHA256='c2f8f827f217a3c3b3b7ed263205947b7c601113a11d298a65dce03045f16a9f'
UPSTREAM='ad8c26442076e357f5bb88515b25dfbf73c81e2e'
def sha(b):return hashlib.sha256(b).hexdigest()
def encode(value):return (json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode()
def package(source,out):
 raw=source.read_bytes()
 if sha(raw)!=SOURCE_SHA256:raise ValueError('Unreviewed upstream archive; update the source binding through review')
 with zipfile.ZipFile(io.BytesIO(raw)) as archive:
  files={n.removeprefix('wordcraft/'):archive.read(n) for n in archive.namelist() if n.startswith('wordcraft/') and not n.endswith('/') and not n.startswith('wordcraft/.zcode-plugin/') and '/dist/assets/' not in n}
 build=json.loads(files['dist/BUILD.json']);assert build['commit']==UPSTREAM
 assert sha(files['dist/tools.json'])==build['toolCatalogSha256']
 with zipfile.ZipFile(io.BytesIO(raw)) as archive:
  for a in build['assets']:
   data=gzip.decompress(archive.read('wordcraft/dist/assets/'+a['sha256']+'.gz'))
   assert len(data)==a['bytes'] and sha(data)==a['sha256'];files['dist/'+a['path']]=data
 panel=files['dist/panel.html'].decode();start='let e=await SC(`${bk}/assets.json`)';end='window.dispatchEvent(new CustomEvent("TrunkApplicationStarted",{detail:{wasm:a}}));'
 assert panel.count(start)==panel.count(end)==1
 i=panel.index(start);j=panel.index(end,i)+len(end);manifest=json.loads(files['dist/assets.json'])
 replacement='let a='+json.dumps({'path':manifest['wasm']})+';let l=await import("./app.js");await l.default({module_or_path:new URL("./'+manifest['wasm']+'",location.href)});window.wasmBindings=l;window.dispatchEvent(new CustomEvent("TrunkApplicationStarted",{detail:{wasm:a}}));'
 files['dist/panel.html']=(panel[:i]+replacement+panel[j:]).encode()
 # Optional resource fallback reads the same hash-checked raw files. They are
 # not duplicated as gzip entries, keeping the package below the 64 MiB limit.
 server=files['dist/server.mjs'].decode();start='function createAssetReader(directory2, entries) {';i=server.index(start);j=server.index('\n}\n',i)+3
 server=server[:i]+'''function createAssetReader(directory2, entries) {
  const byId = new Map(entries.map(asset => [asset.id, asset]));
  return async id => {
    const asset=byId.get(id);
    if(!asset || !/^[a-f0-9]{64}$/.test(id)) throw Error("Unknown asset");
    const bytes=await readFile(resolve(directory2,"..",asset.path));
    if(bytes.length!==asset.bytes || sha256(bytes)!==asset.sha256) throw Error("Asset integrity check failed");
    return bytes;
  };
}
'''+server[j:];files['dist/server.mjs']=server.encode()
 files['dist/launch.mjs']=b'''if (!process.env.XHARNESS_PLUGIN_WORKSPACE) throw Error('Session workspace is required');
process.env.ZCODE_WORKSPACE_ROOT=process.env.XHARNESS_PLUGIN_WORKSPACE;
await import('./server.mjs');
'''
 files['LICENSE']=files['dist/licenses/LICENSE-MIT']
 files['RELEASE.md']=b"""# Optional XHarness WordCraft adapter 0.1.0
Experimental opt-in integration; not an ArtCraft or ZCode product or endorsement.
Requires XHarness optional-panel support and an existing Node.js runtime. Nothing
is installed or enabled automatically. Python remains the normal document path.
Install, explicitly allow MCP, choose full access for the intended session, then
open a workspace DOCX with Edit with WordCraft. The package cannot grant access.
AI editing requires a visible, ready editor. Hiding retains unsaved state but
blocks new model operations. If hidden during an operation, inspect its outcome
once visible; never blindly replay an outcome-unknown edit. Save before closing.
Closing a live operation is rejected. Reload/crash cannot restore unsaved browser
memory: explicit discard is required to reopen a stale editor from the saved file.
Up to two editor panels are retained. The unmodified WASM is 88.45 MB and loads
only after explicit opening. Fonts/page layout can differ from Microsoft Word;
complex DOCX fidelity is not certified. No default enablement or host restart.
All upstream license notices are retained under dist/licenses. This adapter
changes only the transport/bootstrap; the WordCraft engine binary is unchanged.
"""
 files['.claude-plugin/plugin.json']=encode({'name':'wordcraft','version':'0.1.0','description':'Optional live WordCraft document editor. Disabled until explicitly authorized and opened.','license':'MIT OR Apache-2.0'})
 files['.mcp.json']=encode({'mcpServers':{'wordcraft':{'type':'stdio','command':'node','args':['${PLUGIN_ROOT}/dist/launch.mjs']}}})
 assets={}
 for p in ['dist/panel.html']+['dist/'+a['path'] for a in build['assets']]:
  data=files[p];mime='text/html' if p.endswith('.html') else 'application/wasm' if p.endswith('.wasm') else 'text/javascript' if p.endswith('.js') else 'image/x-icon'
  assets[p]={'bytes':len(data),'sha256':sha(data),'mime':mime}
 files['.xharness-ui.json']=encode({'version':1,'server':'wordcraft','resourceUri':'ui://wordcraft/panel.html','entry':'dist/panel.html','title':'WordCraft','openTool':'open_editor','assets':assets})
 files['skills/wordcraft/SKILL.md']=b'''---
name: wordcraft
description: Work with an explicitly opened WordCraft visual editor. Normal document automation should continue to use Python.
---
Use only when the user wants visual co-editing and has enabled and opened the WordCraft document panel. Installing or allowing MCP must not start it. Discover tools through plugin_mcp; never call app-only _editor_* operations. Query list_commands with a focused query, not the full large catalogue. Keep the editor visible and ready for AI edits; hidden panels reject new operations. Inspect current selection and dirty state before editing. Image insertion selects the image: collapse the selection with caret.right before inserting following text. In the web build use image data rather than a native filesystem path. Save before opening another document. Confirm saved files by reopening or inspecting them, and render relevant pages. Tool errors and cancelled/outcome-unknown edits must not be blindly replayed. Complex DOCX page fidelity is not guaranteed.
'''
 files['dist/XHARNESS-PROVENANCE.json']=encode({'sourceArchiveSha256':SOURCE_SHA256,'upstream':UPSTREAM,'wordcraftVersion':'0.5.0','adapterVersion':'0.2.3','pluginVersion':'0.1.0','wasmUnchanged':True,'patches':['relative streaming asset bootstrap','raw fallback assets without retained gzip cache','Host-injected session workspace launcher'],'assetDigests':assets})
 assert sum(map(len,files.values()))<=128*1024*1024
 out.parent.mkdir(parents=True,exist_ok=True)
 with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
  for p,data in sorted(files.items()):
   info=zipfile.ZipInfo('wordcraft/'+p,date_time=(2026,11,10,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16;archive.writestr(info,data,compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
 assert out.stat().st_size<=64*1024*1024
 return {'name':'wordcraft','version':'0.1.0','sha256':sha(out.read_bytes()),'bytes':out.stat().st_size,'unpackedBytes':sum(map(len,files.values())),'files':len(files),'wasmSha256':next(a['sha256'] for p,a in assets.items() if p.endswith('.wasm'))}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--source-zip',type=pathlib.Path,required=True);p.add_argument('--out',type=pathlib.Path,required=True);a=p.parse_args();print(json.dumps(package(a.source_zip,a.out),indent=2))

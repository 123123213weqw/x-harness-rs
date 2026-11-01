import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

test('Windows private bridge directories do not depend on inherited PowerShell modules',{
 skip:process.platform!=='win32',timeout:30000
},async()=>{
 const home=await mkdtemp(join(tmpdir(),'xh-windows-acl-'))
 const path=join(home,"bridge with spaces 中文 ' & chars")
 const env={...process.env,PSModulePath:join(home,'no-modules'),XHARNESS_BRIDGE_ACL_PATH:path}
 try{
  const url=pathToFileURL(resolve('dist/native/common.js')).href
  const create=spawnSync(process.execPath,['--input-type=module','-e',`import {privateDirectory} from ${JSON.stringify(url)};await privateDirectory(process.env.XHARNESS_BRIDGE_ACL_PATH);`],{env,encoding:'utf8',timeout:15000,windowsHide:true})
  assert.ifError(create.error);assert.equal(create.status,0,create.stderr)
  // Use .NET directly, too: an empty module path must not weaken the actual ACL.
  const script=`$ErrorActionPreference='Stop';
$path=$env:XHARNESS_BRIDGE_ACL_PATH;
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$acl=[System.IO.Directory]::GetAccessControl($path);
if(-not $acl.AreAccessRulesProtected){throw 'ACL inheritance is not protected'};
if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'Wrong directory owner'};
$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);
if($rules.Count -ne 2){throw 'Unexpected ACL rule count'};
foreach($rule in $rules){
 if(($rule.IdentityReference.Value -ne $sid -and $rule.IdentityReference.Value -ne 'S-1-5-18') -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne 'ContainerInherit,ObjectInherit'){throw 'Unexpected bridge ACL permission'};
};
[Console]::WriteLine('private-acl-verified');`
  const inspect=spawnSync(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,encoding:'utf8',timeout:10000,windowsHide:true})
  assert.ifError(inspect.error);assert.equal(inspect.status,0,inspect.stderr)
  assert.match(inspect.stdout,/private-acl-verified/)
 }finally{await rm(home,{recursive:true,force:true})}
})

"""Offline contracts; native acceptance is explicit, uses synthetic items only."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('local_helper',Path(__file__).with_name('macos-keychain-helper.py'))
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)

CALLER=r'''
#include <Security/Security.h>
#include <sys/wait.h>
#include <unistd.h>
#include <string.h>
#ifndef VARIANT
#define VARIANT "A"
#endif
int main(int argc,char**argv){
  volatile char variant[]=VARIANT; if (!variant[0] || argc!=5) return 2;
  pid_t child=fork(); if(child<0)return 2;
  if(!child){execl(argv[1],argv[1],argv[2],argv[3],argv[4],(char*)0);_exit(127);}
  int status; if(waitpid(child,&status,0)!=child)return 2;
  return WIFEXITED(status)?WEXITSTATUS(status):125;
}
'''

def native_fixture(identity, keychain=None):
    m.require(sys.platform=='darwin','Native fixture requires macOS')
    cases=[]
    with tempfile.TemporaryDirectory(prefix='xh-keychain-caller-') as folder:
        root=Path(folder); helper=root/'helper'; m.build(helper,identity,keychain=keychain)
        before=hashlib.sha256(helper.read_bytes()).hexdigest()
        source=root/'caller.c';source.write_text(CALLER)
        callers=[]
        for variant,identifier in [('A','xharness-host'),('B','xharness-host'),('C','com.xharness.wrong-caller'),('D','com.xlang.xharness.host')]:
            path=root/variant
            m.command(['/usr/bin/clang','-Wno-deprecated-declarations','-DVARIANT="'+variant+'"',source,'-framework','Security','-o',path])
            args=['/usr/bin/codesign','--force','--sign',identity,'--identifier',identifier,'--options','runtime','--timestamp=none']
            if keychain is not None: args+=['--keychain',keychain]
            m.command([*args,path]);callers.append(path)
        service='com.xlang.xharness.models.'+hashlib.sha256(secrets.token_bytes(32)).hexdigest()
        ref='XHARNESS_FIXTURE_'+secrets.token_hex(12)
        fixture=b'synthetic-not-a-real-provider-key'
        def call(caller,action,*,data=b'',expected=0,service_arg=service,ref_arg=ref):
            p=subprocess.run([str(caller),str(helper),action,service_arg,ref_arg],input=data,capture_output=True,timeout=25)
            m.require(p.returncode==expected,'Native helper case failed (no secret output retained)')
            cases.append({'action':action,'caller':caller.name,'exit':p.returncode})
            return p.stdout
        created=False
        channel_created=False
        channel_service=service.replace('.models.','.channels.')
        try:
            call(callers[0],'get',expected=3)
            call(callers[0],'set',data=fixture);created=True
            m.require(call(callers[0],'get')==fixture,'First Host failed synthetic read')
            # Different Host content + identifier, same cert, unchanged helper.
            m.require(call(callers[1],'get')==fixture,'Updated Host failed synthetic read')
            call(callers[2],'get',expected=4)
            m.require(call(callers[3],'get')==fixture,'Long-form Host identifier failed')
            adhoc=root/'adhoc-caller';adhoc.write_bytes(callers[0].read_bytes());adhoc.chmod(0o700)
            m.command(['/usr/bin/codesign','--force','--sign','-','--identifier','xharness-host',adhoc])
            call(adhoc,'get',expected=4)
            p=subprocess.run([str(helper),'get',service,ref],capture_output=True,timeout=10)
            m.require(p.returncode==4 and not p.stdout,'Direct non-Host parent was accepted')
            cases.append({'action':'get','caller':'python-direct','exit':p.returncode})
            call(callers[0],'get',service_arg='com.foreign.secrets',expected=2)
            call(callers[0],'get',ref_arg='REF/INVALID',expected=2)
            call(callers[0],'invalid',expected=2)
            call(callers[0],'get',ref_arg='A'*129,expected=2)
            call(callers[1],'set',data=b'x'*65537,expected=1)
            m.require(call(callers[0],'get')==fixture,'Oversized write changed existing credential')
            call(callers[1],'set',data=b'',expected=1)
            call(callers[1],'set',data=b'replaced-synthetic-key')
            m.require(call(callers[0],'get')==b'replaced-synthetic-key','Credential rotation failed')
            call(callers[0],'set',service_arg=channel_service,data=b'channel-synthetic');channel_created=True
            m.require(call(callers[1],'get',service_arg=channel_service)==b'channel-synthetic','Channel namespace failed')
            m.require(call(callers[0],'get')==b'replaced-synthetic-key','Namespaces were not isolated')
            call(callers[1],'delete',service_arg=channel_service);channel_created=False
            call(callers[1],'delete');created=False
            call(callers[0],'get',expected=3)
            m.require(hashlib.sha256(helper.read_bytes()).hexdigest()==before,'Helper changed during Host upgrade')
        finally:
            if created: call(callers[0],'delete')
            if channel_created: call(callers[0],'delete',service_arg=channel_service)
        return {'passed':True,'helperUnchangedAcrossHosts':True,'syntheticItemsRemoved':True,
                'productionCredentialsRead':False,'cases':cases}


class Contracts(unittest.TestCase):
    def test_invalid_pin(self):
        for pin in ['', 'a'*39, 'A'*40, '../identity']:
            with self.assertRaises(ValueError):m.fingerprint(pin)
    @unittest.skipUnless(os.name=="posix", "Private setup uses POSIX ownership")
    def test_install_reuses_exact_bytes_and_rejects_foreign_pins(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder); source=state/"source.c";source.write_text("fixture source"); host=state/"host"
            def fake_build(output, identity):
                output.write_bytes(b"fixture-binary");output.chmod(0o700)
            with patch.object(m.sys,"platform","darwin"),patch.object(m,"SOURCE",source),patch.object(m,"signed"),patch.object(m,"build",side_effect=fake_build) as build:
                first=m.install(state,"a"*40,host); binary=state/"credential-helper/v1/xharness-keychain-helper"; before=binary.read_bytes()
                second=m.install(state,"a"*40,host)
                self.assertFalse(first["reusedUnchanged"]);self.assertTrue(second["reusedUnchanged"]);self.assertEqual(build.call_count,1)
                config=state/"local-keychain-helper.json";config.write_text("{}")
                with self.assertRaises(ValueError):m.install(state,"a"*40,host)
                self.assertEqual(binary.read_bytes(),before)

    def test_narrow_native_protocol(self):
        source=m.SOURCE.read_text()
        self.assertIn('getppid()',source);self.assertIn('SecCodeCheckValidity(parent',source)
        self.assertIn('certificate leaf = H',source);self.assertIn('SecKeychainCopyDomainDefault',source)
        self.assertNotIn('system(',source);self.assertNotIn('popen(',source)
        self.assertIn('MAX_SECRET',source);self.assertIn('wipe(',source)
    def test_immutable_install_and_no_secret_or_global_ACL_commands(self):
        source=Path(m.__file__).read_text()
        for bad in ['set-generic-password-partition-list','add-generic-password','find-generic-password','set-key-partition-list','find-key']:
            self.assertNotIn(bad,source)
        self.assertIn('reusedUnchanged',source);self.assertIn('never overwrite silently',source)
        self.assertIn('os.O_NOFOLLOW',source)

if __name__=='__main__':
    if '--native' in sys.argv:
        identity=sys.argv[sys.argv.index('--identity')+1]
        print(json.dumps(native_fixture(identity)))
    else:unittest.main()

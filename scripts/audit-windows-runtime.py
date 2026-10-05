#!/usr/bin/env python3
"""Fail-closed PE import audit of the *extracted* NSIS payload (stdlib only).

A hosted runner's installed VC runtime must never hide a packaging dependency.
System imports use a reviewed allowlist, not the runner's System32 directory.
This is a loader-dependency gate, not a substitute for clean-VM execution.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile

OWNED = {'xharness-desktop.exe', 'xharness-host.exe', 'xharness-windows-sandbox-runner.exe'}
REQUIRED = OWNED | {'rg.exe'}
SYSTEM = set('''advapi32.dll avrt.dll bcrypt.dll bcryptprimitives.dll cabinet.dll
cfgmgr32.dll clbcatq.dll comctl32.dll comdlg32.dll crypt32.dll cryptbase.dll cryptsp.dll
 d2d1.dll d3d11.dll d3d12.dll dcomp.dll dbghelp.dll dnsapi.dll dwmapi.dll dwrite.dll
 dxgi.dll gdi32.dll gdi32full.dll hid.dll imm32.dll iphlpapi.dll kernel32.dll kernelbase.dll
 mf.dll mfplat.dll mfreadwrite.dll mpr.dll msimg32.dll msvcp_win.dll msvcrt.dll
 ncrypt.dll netapi32.dll normaliz.dll ntdll.dll ole32.dll oleacc.dll oleaut32.dll
 powrprof.dll propsys.dll psapi.dll rpcrt4.dll secur32.dll setupapi.dll shcore.dll
 shell32.dll shlwapi.dll sspicli.dll ucrtbase.dll urlmon.dll user32.dll userenv.dll
 usp10.dll uxtheme.dll version.dll wevtapi.dll winhttp.dll wininet.dll winmm.dll
 winspool.drv wintrust.dll wldap32.dll ws2_32.dll wtsapi32.dll'''.split())
MSVC = re.compile(r'^(?:vcruntime\d+[^/]*|msvcp\d+[^/]*|concrt\d+[^/]*|msvcr\d+[^/]*)\.dll$')
NAME = re.compile(r'^[a-zA-Z0-9_.+-]+\.(?:dll|drv)$')
MAX_MODULE = 256 * 1024 * 1024


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


class PE:
    def __init__(self, data):
        self.data = data
        require(len(data) <= MAX_MODULE, 'PE exceeds size limit')
        require(self.slice(0, 2) == b'MZ', 'Missing DOS signature')
        pe = self.u32(60)
        require(pe >= 64 and self.slice(pe, 4) == b'PE\0\0', 'Missing PE signature')
        self.machine = self.u16(pe + 4)
        count, size = self.u16(pe + 6), self.u16(pe + 20)
        require(0 < count <= 96, 'Invalid PE section count')
        opt = pe + 24
        self.slice(opt, size)
        magic = self.u16(opt)
        if magic == 0x20b:
            base_offset, number_offset, directory_offset = 24, 108, 112
            self.image_base = self.u64(opt + base_offset)
        elif magic == 0x10b:
            number_offset, directory_offset = 92, 96
            self.image_base = self.u32(opt + 28)
        else:
            raise ValueError('Unknown PE optional-header magic')
        require(size >= directory_offset, 'Truncated optional header')
        self.headers_size = self.u32(opt + 60)
        require(self.headers_size <= len(data), 'Invalid header size')
        n = self.u32(opt + number_offset)
        require(n <= 16 and directory_offset + n * 8 <= size, 'Truncated data directories')
        self.directories = [struct.unpack('<II', self.slice(opt + directory_offset + i * 8, 8)) for i in range(n)]
        self.sections = []
        for i in range(count):
            section = opt + size + i * 40
            self.slice(section, 40)
            virtual_size, rva, raw_size, raw = struct.unpack('<IIII', self.slice(section + 8, 16))
            self.slice(raw, raw_size)
            self.sections.append((rva, max(virtual_size, raw_size), raw, raw_size))

    def slice(self, offset, size):
        require(0 <= offset <= len(self.data) and 0 <= size <= len(self.data) - offset,
                'Truncated PE data')
        return self.data[offset:offset + size]

    def u16(self, offset):
        return struct.unpack('<H', self.slice(offset, 2))[0]

    def u32(self, offset):
        return struct.unpack('<I', self.slice(offset, 4))[0]

    def u64(self, offset):
        return struct.unpack('<Q', self.slice(offset, 8))[0]

    def offset(self, rva, size):
        candidates = []
        if rva < self.headers_size and rva + size <= self.headers_size:
            candidates.append(rva)
        for start, virtual_size, raw, raw_size in self.sections:
            if start <= rva < start + virtual_size:
                delta = rva - start
                require(delta + size <= raw_size, 'RVA points outside file-backed section')
                candidates.append(raw + delta)
        require(len(candidates) == 1, 'Unmapped or ambiguous RVA')
        self.slice(candidates[0], size)
        return candidates[0]

    def dll_name(self, rva):
        chars = []
        for i in range(256):
            byte = self.data[self.offset(rva + i, 1)]
            if byte == 0:
                name = bytes(chars).decode('ascii')
                require(NAME.fullmatch(name), 'Unsafe or malformed import name')
                return name.lower()
            chars.append(byte)
        raise ValueError('Unterminated import name')

    def imports(self):
        results = set()
        for index, width in [(1, 20), (13, 32)]:
            if len(self.directories) <= index:
                continue
            rva, size = self.directories[index]
            require((rva == 0) == (size == 0), 'Incomplete import directory')
            if not rva:
                continue
            require(width <= size <= 4096 * width, 'Invalid import directory size')
            terminated = False
            for pos in range(0, size - width + 1, width):
                entry = self.slice(self.offset(rva + pos, width), width)
                if not any(entry):
                    terminated = True
                    break
                fields = struct.unpack('<' + 'I' * (width // 4), entry)
                if index == 1:
                    name = fields[3]
                else:
                    require(fields[0] in (0, 1), 'Unknown delay-import attributes')
                    name = fields[1] if fields[0] == 1 else fields[1] - self.image_base
                require(name > 0, 'Invalid import-name RVA')
                results.add(self.dll_name(name))
            require(terminated, 'Unterminated import directory')
        return sorted(results)


def system(name):
    return name in SYSTEM or name.startswith(('api-ms-win-', 'ext-ms-win-'))


def audit(root, *, desktop_required=True, expected=None):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), 'Missing payload directory')
    modules, by_path = [], {}
    for path in sorted(root.rglob('*')):
        require(not path.is_symlink(), 'Symlink in extracted payload')
        if not path.is_file() or path.suffix.lower() not in ('.exe', '.dll'):
            continue
        # Installer plugins have a separate x86 loader; they are not app payload.
        if '$PLUGINSDIR' in path.relative_to(root).parts:
            continue
        require(path.stat().st_size <= MAX_MODULE, 'Oversized PE module')
        pe = PE(path.read_bytes())
        relative = path.relative_to(root).as_posix()
        key = relative.lower()
        require(key not in by_path, 'Case-colliding PE paths')
        require(pe.machine == 0x8664, 'Non-x64 application module: ' + relative)
        record = {'path': relative, 'sha256': digest(path), 'machine': 'AMD64', 'imports': pe.imports()}
        by_path[key] = record
        modules.append(record)
        require(len(modules) <= 2048, 'Too many PE modules')
    required = REQUIRED if desktop_required else REQUIRED - {'xharness-desktop.exe'}
    require(required <= set(by_path), 'Missing root application modules: ' + ', '.join(sorted(required - set(by_path))))
    for record in modules:
        folder = Path(record['path']).parent.as_posix().lower()
        for name in record['imports']:
            require(not (Path(record['path']).name.lower() in OWNED and MSVC.fullmatch(name)),
                    'Owned executable imports dynamic MSVC runtime: ' + record['path'] + ' -> ' + name)
            local = name if folder == '.' else folder + '/' + name
            require(system(name) or local in by_path or name in by_path,
                    'Unpackaged loader dependency: ' + record['path'] + ' -> ' + name)
    if expected is not None:
        require(required <= set(expected), 'Incomplete expected build manifest')
        for name in required:
            require(by_path[name]['sha256'] == expected[name], 'Stale or mixed installer payload: ' + name)
    return {'schema': 1, 'passed': True, 'modules': modules}


def expected_build(desktop, sidecars, target):
    result = {}
    if desktop:
        result['xharness-desktop.exe'] = digest(Path(desktop))
    for name in REQUIRED - {'xharness-desktop.exe'}:
        path = Path(sidecars) / (Path(name).stem + '-' + target + '.exe')
        require(path.is_file(), 'Missing staged sidecar: ' + name)
        result[name] = digest(path)
    return result


def installer_audit(installer, expected=None, seven_zip=None):
    installer = Path(installer)
    require(installer.is_file() and not installer.is_symlink(), 'Missing installer')
    tool = seven_zip or shutil.which('7z') or shutil.which('7zz')
    if tool is None and os.name == 'nt':
        candidate = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / '7-Zip/7z.exe'
        if candidate.is_file():
            tool = str(candidate)
    require(tool is not None, '7-Zip is required for final NSIS dependency audit')
    with tempfile.TemporaryDirectory(prefix='xharness-pe-') as temp:
        subprocess.run([str(tool), 'x', '-y', '-bd', '-o' + temp, str(installer.resolve())],
                       check=True, stdout=subprocess.DEVNULL, timeout=180)
        desktops = [p for p in Path(temp).rglob('*') if p.name.lower() == 'xharness-desktop.exe']
        require(len(desktops) == 1, 'Expected exactly one desktop executable in NSIS')
        report = audit(desktops[0].parent, expected=expected)
    report['installer_sha256'] = digest(installer)
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument('--installer', type=Path)
    group.add_argument('--directory', type=Path)
    p.add_argument('--portable-host', action='store_true')
    p.add_argument('--expected-desktop', type=Path)
    p.add_argument('--sidecars', type=Path)
    p.add_argument('--target', default='x86_64-pc-windows-msvc')
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    require(not args.expected_desktop or args.sidecars, 'Expected desktop requires staged sidecars')
    require(not args.installer or not args.portable_host, 'NSIS must include desktop')
    expected = expected_build(args.expected_desktop, args.sidecars, args.target) if args.sidecars else None
    report = (installer_audit(args.installer, expected) if args.installer else
              audit(args.directory, desktop_required=not args.portable_host, expected=expected))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print('Windows runtime dependency audit passed: ' + str(len(report['modules'])) + ' PE modules')


if __name__ == '__main__':
    main()

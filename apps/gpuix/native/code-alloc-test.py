"""Standalone tests exercise the reconstructed global allocator, without GPUI."""
from pathlib import Path
import os, subprocess, tempfile
native = Path(__file__).resolve().parent
source = (native / 'upstream/packages/native/src/large_alloc.rs').read_text().split('pub(crate) fn memory_stats()')[0]
for patch in ['code_alloc.rs', 'code_small.rs']:
    source = source.replace(f'include!("{patch}");', (native / 'patches' / patch).read_text())
with tempfile.TemporaryDirectory(prefix='code-alloc-', dir=native / 'build') as folder:
    source_file = Path(folder) / 'allocator.rs'
    source_file.write_text(source)
    manifest = Path(folder) / 'Cargo.toml'
    manifest.write_text('''[package]
name = "code-allocator-tests"
version = "0.0.0"
edition = "2021"
[workspace]
[lib]
path = "allocator.rs"
[dependencies]
serde_json = "1"
mimalloc = { version = "=0.1.52", default-features = false }
libmimalloc-sys = { version = "=0.1.49", default-features = false, features = ["extended"] }
''')
    command = ['cargo', '+1.97.1', 'test', '--release', '--lib', '--manifest-path', str(manifest), '--target-dir', str(native / 'build/target')]
    controls = [{'KYBERN_CODE_MEMORY':'1'}, {'KYBERN_CODE_MEMORY':'0'}, {'KYBERN_CODE_MEMORY':'1','KYBERN_CODE_SMALL_MEMORY':'0'}, {'KYBERN_CODE_MEMORY':'1','KYBERN_CODE_POST_FRAME_MEMORY':'0'}]
    for control in controls:
        print(control, flush=True)
        subprocess.run([*command, '--', '--test-threads=1'], env={**os.environ, **control}, check=True)
    subprocess.run([*command, '--', '--ignored', '--test-threads=1'], env={**os.environ,'KYBERN_LARGE_ALLOCATIONS_VM':'0'}, check=True)

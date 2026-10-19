"""Exercise the exact allocator source, with no GPUI window or external crate."""
import os
from pathlib import Path
import subprocess

app = Path(__file__).resolve().parents[2]
binary = app / 'native/build/large-alloc-tests'
subprocess.run(['rustc', '--edition=2021', '--test', str(app / 'native/patches/large_alloc.rs'), '-o', str(binary)], check=True)
subprocess.run([str(binary), '--test-threads=1'], env=dict(os.environ, KYBERN_LARGE_ALLOCATIONS_VM='1'), check=True)
subprocess.run([str(binary), '--ignored', '--exact', 'tests::disabled_control_uses_system', '--test-threads=1'],
               env=dict(os.environ, KYBERN_LARGE_ALLOCATIONS_VM='0'), check=True)

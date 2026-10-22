"""Run the real patched arena's allocation/drop/scope tests without GPUI linking.

The standalone source only replaces log macros (the arena's sole external
dependency); allocation, ownership, destructors and scope logic stay intact.
"""
from pathlib import Path
import subprocess
import json
import os

native = Path(__file__).resolve().parents[1]
source = (native / 'upstream/zed/crates/gpui/src/arena.rs').read_text()
source = source.replace('log::debug!', 'eprintln!').replace('log::trace!', 'eprintln!')
source = '#[path = ' + json.dumps(str(native / 'patches/code_frame.rs')) + ']\nmod code_frame;\n' + source
generated = native / 'build/memory-arena-tests.rs'
binary = native / ('build/memory-arena-tests' + os.environ.get('KYBERN_EXE_SUFFIX', ''))
generated.write_text(source)
subprocess.run(['rustc', '--edition=2024', '--test', str(generated), '-o', str(binary)], check=True)
subprocess.run([str(binary)], check=True)

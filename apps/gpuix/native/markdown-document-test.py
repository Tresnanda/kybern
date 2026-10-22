"""Run pure parser/append parity tests against the pinned native dependencies."""
from pathlib import Path
import os
import subprocess

root = Path(__file__).resolve().parent
# A cross build (update.sh with KYBERN_GPUIX_TARGET) keeps its dependencies under the target triple;
# the test is built for that target too, and an x86_64 one runs under Rosetta.
host = subprocess.run(["rustc", "+1.97.1", "-vV"], capture_output=True, text=True, check=True).stdout.split("host: ")[1].split()[0]
target = os.environ.get("KYBERN_GPUIX_TARGET", host)
cross = [] if target == host else ["--target", target]
deps = root / ("build/target/release/deps" if not cross else f"build/target/{target}/release/deps")
rlib = next(deps.glob("libpulldown_cmark-*.rlib"))
wrapper = root / "build/markdown-model-test.rs"
# Forward slashes: a Windows path's backslashes would be escapes inside the attribute string.
wrapper.write_text(
    'mod markdown {#[path="' + (root / "upstream/packages/native/src/markdown/parser.rs").as_posix() + '"] pub mod parser;}\n'
    '#[path="' + (root / "patches/markdown_model.rs").as_posix() + '"] mod markdown_model;\n'
)
output = root / ("build/markdown-model-tests" + os.environ.get("KYBERN_EXE_SUFFIX", ""))
subprocess.run([
    "rustc", "+1.97.1", "--edition=2021", "--test", str(wrapper),
    "--extern", "pulldown_cmark=" + str(rlib), "-L", "dependency=" + str(deps),
    *cross, "-o", str(output),
], check=True)
subprocess.run([str(output)], check=True)

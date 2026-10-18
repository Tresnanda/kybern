"""Run pure parser/append parity tests against the pinned native dependencies."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
deps = root / "build/target/release/deps"
rlib = next(deps.glob("libpulldown_cmark-*.rlib"))
wrapper = root / "build/markdown-model-test.rs"
wrapper.write_text(
    'mod markdown {#[path="' + str(root / "upstream/packages/native/src/markdown/parser.rs") + '"] pub mod parser;}\n'
    '#[path="' + str(root / "patches/markdown_model.rs") + '"] mod markdown_model;\n'
)
output = root / "build/markdown-model-tests"
subprocess.run([
    "rustc", "+1.97.1", "--edition=2021", "--test", str(wrapper),
    "--extern", "pulldown_cmark=" + str(rlib), "-L", "dependency=" + str(deps),
    "-o", str(output),
], check=True)
subprocess.run([str(output)], check=True)

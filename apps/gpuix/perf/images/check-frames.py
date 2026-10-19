"""Run the pinned GPUI RenderImage tests with its real image/smallvec crates.

Only GPUI's pixel/size aliases are supplied here; the frame constructor and
its tests are read directly from the reconstructed assets.rs, not copied.
Run after native/update.sh under the same build marker.
"""
from pathlib import Path
import subprocess

app = Path(__file__).resolve().parents[2]
build = app / 'native/build'
deps = build / 'target/release/deps'
def library(name):
    found = list(deps.glob(f'lib{name}-*.rlib'))
    assert found, f'Missing {name} native dependency in {deps}'
    # Repeated update.sh runs can leave both an older and a current crate hash.
    # The newest release rlib matches the reconstructed source build.
    return str(max(found, key=lambda file: (file.stat().st_mtime_ns, file.name)))
source = app / 'native/upstream/zed/crates/gpui/src/assets.rs'
harness = build / 'image-frames-tests.rs'
harness.write_text("""
#![allow(dead_code)]
pub type Result<T> = std::result::Result<T, ()>;
pub type SharedString = String;
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct DevicePixels(pub i32);
impl From<u32> for DevicePixels { fn from(v:u32)->Self { Self(v as i32) } }
#[derive(Copy, Clone, Debug, Default, PartialEq)]
pub struct Pixels(pub f32);
impl From<f32> for Pixels { fn from(v:f32)->Self { Self(v) } }
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct Size<T> { pub width:T, pub height:T }
pub fn size<T>(width:T,height:T)->Size<T> { Size {width,height} }
impl<T> Size<T> { pub fn map<U>(self,mut f:impl FnMut(T)->U)->Size<U> { size(f(self.width),f(self.height)) } }
""" + f'\n#[path = "{source}"] mod assets;\n')
try:
    subprocess.run(['rustc', '+1.97.1', '--edition=2024', '--test', str(harness),
                    '--extern', 'image=' + library('image'), '--extern', 'smallvec=' + library('smallvec'),
                    '-L', 'dependency=' + str(deps), '-o', str(build / 'image-frames-tests')], check=True)
    subprocess.run([str(build / 'image-frames-tests')], check=True)
finally:
    harness.unlink(missing_ok=True)

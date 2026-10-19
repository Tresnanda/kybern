"""Exclusive, bounded-concurrency daemon validation; never builds GPUIX itself."""
import datetime, fcntl, os, pathlib, shutil, subprocess, time

root = pathlib.Path(__file__).resolve().parents[5]
out = pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/handson-r5/order')
out.mkdir(parents=True, exist_ok=True)
marker = pathlib.Path('/tmp/kybern-gpuix-native-build.hr5-order')
reservation = pathlib.Path('/tmp/kybern-gpuix-build-next.hr5-order')
owned = False
while True:
    with open('/tmp/kybern-gpuix-build-reservation-lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        others = [p for p in pathlib.Path('/tmp').glob('kybern-gpuix-build-next.*') if p != reservation]
        if not others:
            reservation.write_text('hr5-order daemon build ' + datetime.datetime.now().isoformat())
            break
    time.sleep(1)
try:
    while list(pathlib.Path('/tmp').glob('kybern-gpuix-native-build.*')) or list(pathlib.Path('/tmp').glob('kybern-gpuix-quiet.*')):
        time.sleep(1)
    if shutil.disk_usage(root).free < 30 * 1024**3:
        raise RuntimeError('Under 30 GiB free; refusing build')
    marker.write_text('hr5-order daemon build ' + datetime.datetime.now().isoformat())
    owned = True
    if len(list(pathlib.Path('/tmp').glob('kybern-gpuix-native-build.*'))) != 1:
        raise RuntimeError('Another native builder won the slot')
    reservation.unlink()
    env = dict(os.environ, CARGO_TARGET_DIR=str(root/'target'), CARGO_INCREMENTAL='0', CARGO_BUILD_JOBS='4', RUSTC_WRAPPER='', CARGO_PROFILE_DEV_DEBUG='0', CARGO_PROFILE_TEST_DEBUG='0')
    commands = [
        ('daemon-build', ['cargo', 'build', '-p', 'kybern']),
        ('protocol-tests', ['cargo', 'test', '-p', 'kybern-protocol']),
        ('daemon-project-tests', ['cargo', 'test', '-p', 'kybern-daemon', 'projects_list_refreshes_git_without_an_existing_thread']),
        ('clippy', ['cargo', 'clippy', '-p', 'kybern-protocol', '-p', 'kybern-daemon', '-p', 'kybern-cli', '--all-targets', '--', '-D', 'warnings']),
    ]
    for name, command in commands:
        with (out/(name+'.log')).open('w') as log:
            subprocess.run(['nice', '-n', '15', *command], cwd=root, env={**env, **({'INSTA_UPDATE':'always'} if name=='protocol-tests' else {})}, stdout=log, stderr=subprocess.STDOUT, check=True)
        print(name + ': passed', flush=True)
finally:
    if owned:
        marker.unlink(missing_ok=True)
    reservation.unlink(missing_ok=True)

"""Shared `--check` support for the anchored JS package patches.

The native sources live in the Kybern forks (`../FORK`); only the npm JS
packages are still patched by anchored edits (`patch_js.py`, `patch_react.py`).
Normally an anchor that moved stops the driver at the first miss and nothing is
written. With `--check` every driver keeps going and collects every missing or
duplicated anchor, so a GPUIX update shows the whole porting list at once
instead of one miss per run:

    python3 patches/patch_js.py <dir of the @gpuix/native package> --check
    python3 patches/patch_react.py <dir of the @gpuix/react package> --check

Run it against a disposable copy: the drivers still write the hooks that did
match. Exit code 1 when anything is missing, with one `MISSING` line per anchor. A miss can cascade,
since later edits sometimes anchor on text an earlier edit would have added;
fix the first miss in a file first and rerun.
"""
import re
import sys
import traceback
from pathlib import Path

CHECK = "--check" in sys.argv
problems: list[str] = []
_current = [Path(sys.argv[0]).name]


def missing(message: str) -> None:
    """Record one anchor miss (--check), or stop with it (the normal mode)."""
    if not CHECK:
        raise SystemExit(message)
    problems.append(f"{_current[0]}: {message}")


def run(name: str, here: Path, namespace: dict) -> None:
    """Execute one hook file in the driver's namespace.

    A raw `raise SystemExit` or other failure inside the file aborts only that
    file under --check, and is recorded against it.
    """
    previous = _current[0]
    _current[0] = name
    try:
        exec(compile((here / name).read_text(), str(here / name), "exec"), namespace)
    except SystemExit as exc:
        if not CHECK:
            raise
        problems.append(f"{name}: {exc.code}")
    except Exception:
        if not CHECK:
            raise
        problems.append(f"{name}: aborted: {traceback.format_exc().strip().splitlines()[-1]}")
    finally:
        _current[0] = previous


def finish(applied: str) -> None:
    if not CHECK:
        print(applied)
        return
    for line in problems:
        first, *rest = line.split("\n")
        first = first.replace("; nothing written:", "")
        anchor = rest[0].strip()[:140] if rest else ""
        print(f"MISSING {first}" + (f"\n    anchor: {anchor}" + (" …" if len(rest) > 1 else "") if anchor else ""))
    files = sorted({re.split(r":", p, 1)[0] for p in problems})
    print(f"--check: {len(problems)} problem(s) in {len(files)} file(s)" + (": " + ", ".join(files) if files else ""))
    sys.exit(1 if problems else 0)

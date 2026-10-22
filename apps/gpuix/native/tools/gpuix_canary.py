#!/usr/bin/env python3
"""Will the next @gpuix/native release still take our patches?

Cheap, no cargo: checks the latest upstream release against the pinned one the
way `update.sh` would, without building.

  1. Skips when the latest npm release is the one in `native/VERSION`.
  2. Fetches `remorses/gpuix` at the tag and its zed submodule, copies
     `patches/*.rs` and runs the anchored hook drivers with `--check`
     (`apply_hooks.py`, `backdrop_gpui.py`), which list every missing or
     duplicated anchor instead of stopping at the first.
  3. Downloads both npm packages and runs `patch_js.py` / `patch_react.py`
     with `--check`.
  4. Lists napi methods the new release added that one of our patches also
     defines (a name clash is a compile error, and one clash hides the next),
     and napi names defined twice once the patches are applied.

Exit status: 0 current or compatible, 1 something would break (the report says
what), 2 the tool itself failed. `--report FILE` writes the markdown report and
`$GITHUB_OUTPUT` gets `status` (current | compatible | broken), `pinned` and
`latest`. Standard library only; run it with `python3 -I`.

    python3 -I apps/gpuix/native/tools/gpuix_canary.py --report canary.md
    python3 -I apps/gpuix/native/tools/gpuix_canary.py --version 0.11.0 --pinned 0.10.0
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

NATIVE = Path(__file__).resolve().parent.parent
PATCHES = NATIVE / "patches"
REPO = "https://github.com/remorses/gpuix.git"
# `#[napi]` or `#[napi(js_name = "…")]` followed by the method it exports.
NAPI_FN = re.compile(r"#\[napi[^\]]*\]\s*(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?fn\s+(\w+)")
OWN_METHOD = re.compile(r"\bpub\s+fn\s+(\w+)\s*\(\s*&(?:mut\s+)?self\b")


def run(*command, cwd=None, check=True, capture=False):
    result = subprocess.run(
        command, cwd=cwd, check=False, text=True,
        stdout=subprocess.PIPE if capture else None, stderr=subprocess.STDOUT if capture else None,
    )
    if check and result.returncode:
        raise SystemExit(f"{' '.join(map(str, command))} failed ({result.returncode})\n{result.stdout or ''}")
    return result


def latest_release():
    out = run("npm", "view", "@gpuix/native", "version", capture=True).stdout.strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", out):
        raise SystemExit(f"unexpected npm answer: {out!r}")
    return out


def hook_problems(output: str):
    """The MISSING entries of a --check run: each line plus its anchor line."""
    problems, current = [], None
    for line in output.splitlines():
        if line.startswith("MISSING "):
            current = [line[len("MISSING "):]]
            problems.append(current)
        elif current is not None and line.startswith("    anchor:"):
            current.append(line.strip())
            current = None
    return ["\n".join(problem) for problem in problems]


def napi_names(text: str):
    return set(NAPI_FN.findall(text))


def upstream_napi(upstream: Path, tag: str):
    names = set()
    files = run("git", "ls-tree", "-r", "--name-only", tag, "packages/native/src", cwd=upstream, capture=True).stdout.split()
    for name in files:
        if name.endswith(".rs"):
            names |= napi_names(run("git", "show", f"{tag}:{name}", cwd=upstream, capture=True).stdout)
    return names


def our_methods():
    names = set()
    for path in PATCHES.iterdir():
        if path.suffix in (".py", ".rs") and not path.name.startswith("rich_"):
            names |= set(OWN_METHOD.findall(path.read_text()))
    return names


def duplicates(upstream: Path, tag: str):
    """Names a patch defines a second time in a file that already exports them."""
    src = upstream / "packages" / "native" / "src"
    repeated = set()
    for path in src.rglob("*.rs"):
        relative = path.relative_to(upstream).as_posix()
        before = run("git", "show", f"{tag}:{relative}", cwd=upstream, capture=True, check=False)
        if before.returncode:
            continue  # a file of ours
        was = Counter(NAPI_FN.findall(before.stdout))
        now = Counter(NAPI_FN.findall(path.read_text()))
        repeated |= {name for name, count in now.items() if was[name] and count > was[name]}
    return repeated


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", help="release to test (default: latest on npm)")
    parser.add_argument("--pinned", help="release in use (default: native/VERSION)")
    parser.add_argument("--report", help="write a markdown report here")
    parser.add_argument("--keep", help="reuse and keep this work directory")
    args = parser.parse_args()

    pinned = args.pinned or (NATIVE / "VERSION").read_text().strip()
    latest = args.version or latest_release()
    github = os.environ.get("GITHUB_OUTPUT")

    def finish(status, lines):
        text = "\n".join(lines) + "\n"
        print(text)
        if args.report:
            Path(args.report).write_text(text)
        if github:
            with open(github, "a") as handle:
                handle.write(f"status={status}\npinned={pinned}\nlatest={latest}\n")
        sys.exit(1 if status == "broken" else 0)

    if latest == pinned:
        finish("current", [f"GPUIX {pinned} is the latest release; nothing to check."])

    work = Path(args.keep) if args.keep else Path(tempfile.mkdtemp(prefix="gpuix-canary-"))
    work.mkdir(parents=True, exist_ok=True)
    upstream = work / "upstream"
    try:
        if not (upstream / ".git").exists():
            run("git", "clone", "-q", "--filter=blob:none", "--no-checkout", REPO, str(upstream))
        run("git", "-C", str(upstream), "fetch", "-q", "--filter=blob:none", "--tags", "origin")
        tag, old_tag = f"@gpuix/native@{latest}", f"@gpuix/native@{pinned}"
        if (upstream / "zed" / ".git").exists() or (upstream / "zed").exists():
            run("git", "-C", str(upstream / "zed"), "reset", "-q", "--hard", check=False)
            run("git", "-C", str(upstream / "zed"), "clean", "-fdq", check=False)
        run("git", "-C", str(upstream), "checkout", "-q", "--force", tag)
        run("git", "-C", str(upstream), "clean", "-fdq", "packages/native/src")
        run("git", "-C", str(upstream), "submodule", "update", "-q", "--init", "--filter=blob:none", "zed")

        src = upstream / "packages" / "native" / "src"
        for path in PATCHES.glob("*.rs"):
            shutil.copy(path, src / path.name)

        problems = {}
        native = run(sys.executable, "-I", str(PATCHES / "apply_hooks.py"), str(src), "--check", capture=True, check=False)
        problems["native hooks (apply_hooks.py)"] = hook_problems(native.stdout)
        if native.returncode not in (0, 1):
            raise SystemExit(f"apply_hooks.py --check crashed:\n{native.stdout}")
        gpui = run(sys.executable, "-I", str(PATCHES / "backdrop_gpui.py"), str(upstream / "zed"), "--check", capture=True, check=False)
        problems["GPUI hooks (backdrop_gpui.py)"] = hook_problems(gpui.stdout)
        if gpui.returncode not in (0, 1):
            raise SystemExit(f"backdrop_gpui.py --check crashed:\n{gpui.stdout}")

        packages = work / "npm"
        shutil.rmtree(packages, ignore_errors=True)
        for name, script in (("native", "patch_js.py"), ("react", "patch_react.py")):
            target = packages / name
            target.mkdir(parents=True)
            run("npm", "pack", "--ignore-scripts", "--silent", f"@gpuix/{name}@{latest}", cwd=target)
            tarball = next(target.glob("*.tgz"))
            run("tar", "-xzf", str(tarball), "-C", str(target))
            result = run(sys.executable, "-I", str(PATCHES / script), str(target / "package"), "--check", capture=True, check=False)
            if result.returncode not in (0, 1):
                raise SystemExit(f"{script} --check crashed:\n{result.stdout}")
            problems[f"JS patch for @gpuix/{name} ({script})"] = hook_problems(result.stdout)

        added = upstream_napi(upstream, tag) - upstream_napi(upstream, old_tag)
        ours = our_methods()
        clashes = sorted(added & ours)
        repeated = sorted(duplicates(upstream, tag))

        lines = [f"## GPUIX {latest} against the patches for {pinned}", ""]
        broken = bool(clashes or repeated or any(problems.values()))
        for title, items in problems.items():
            lines.append(f"### {title}: {len(items)} missing or duplicated anchor(s)" if items else f"### {title}: all anchors match")
            for item in items:
                first, *rest = item.split("\n")
                lines.append(f"- `{first}`" + ("".join(f"\n  - {line}" for line in rest)))
            lines.append("")
        lines.append("### napi method names")
        lines.append(f"- {len(added)} method(s) are new in {latest}: " + (", ".join(f"`{n}`" for n in sorted(added)) or "none"))
        if clashes:
            lines.append("- **also defined by a patch of ours (drop ours and use upstream's, or rename):** " + ", ".join(f"`{n}`" for n in clashes))
        if repeated:
            lines.append("- **defined twice once the patches are applied:** " + ", ".join(f"`{n}`" for n in repeated))
        if not (clashes or repeated):
            lines.append("- no clash with a method our patches define")
        lines.append("")
        lines.append(
            "Run `apps/gpuix/native/update.sh %s` to port it; the anchors above are what to fix first. "
            "The check is static: a clean report still needs a build (`KYBERN_NATIVE_CHECKS=0 ./update.sh %s`) to catch type errors." % (latest, latest)
            if broken else
            "The patches still apply and no names clash. Run `apps/gpuix/native/update.sh %s` to move to it." % latest
        )
        finish("broken" if broken else "compatible", lines)
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()

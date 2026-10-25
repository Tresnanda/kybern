#!/usr/bin/env python3
"""Will the next @gpuix/native release still take our fork commits?

Cheap, no cargo: replays the pinned fork (`native/FORK`: Tresnanda/gpuix's
`kybern` branch, with Tresnanda/zed's `kybern` branch as its zed submodule) onto
the latest upstream release in a throwaway checkout, without building.

  1. Skips when the latest npm release is the one in `native/VERSION`.
  2. Rebases our gpuix commits (`<old tag>..<FORK commit>`) onto the new tag.
     When the new tag pins a different zed commit, rebases our zed commits
     (`<old zed>..<FORK zed>`) onto it too. A commit that conflicts is recorded
     with its files and replayed with our side of them, so the report lists
     every commit that collides with upstream at once.
  3. Downloads both npm packages and runs `patch_js.py` / `patch_react.py`
     with `--check`.
  4. Lists napi methods the new release added that one of our commits also
     defines (a name clash is a compile error, and one clash hides the next),
     and napi names defined twice in the rebased tree.

Exit status: 0 current or compatible, 1 something would break (the report says
what), 2 the tool itself failed. `--report FILE` writes the markdown report and
`$GITHUB_OUTPUT` gets `status` (current | compatible | broken), `pinned` and
`latest`. `--tree DIR` writes the rebased checkout (zed included) to DIR when it
is clean, for `KYBERN_GPUIX_SOURCE=DIR update.sh <latest>`. `--ref` tests an
upstream branch or commit instead of a release tag (`--ref main` previews the
next release). Nothing is pushed. Standard library only; run it with `python3 -I`.

    python3 -I apps/gpuix/native/tools/gpuix_canary.py --report canary.md
    python3 -I apps/gpuix/native/tools/gpuix_canary.py --ref main --tree /tmp/gpuix-main
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
ZED_REPO = "https://github.com/remorses/zed.git"
# `#[napi]` or `#[napi(js_name = "…")]` followed by the method it exports.
NAPI_FN = re.compile(r"#\[napi[^\]]*\]\s*(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?fn\s+(\w+)")
OWN_METHOD = re.compile(r"\bpub\s+fn\s+(\w+)\s*\(\s*&(?:mut\s+)?self\b")
# The replayed commits are throwaway and never pushed; they still need a committer.
GIT_ENV = {**os.environ, "GIT_COMMITTER_NAME": "GPUIX canary", "GIT_COMMITTER_EMAIL": "canary@localhost",
           "GIT_EDITOR": "true", "GIT_TERMINAL_PROMPT": "0"}


def run(*command, cwd=None, check=True, capture=False):
    result = subprocess.run(
        command, cwd=cwd, check=False, text=True, env=GIT_ENV,
        stdout=subprocess.PIPE if capture else None, stderr=subprocess.STDOUT if capture else None,
    )
    if check and result.returncode:
        raise SystemExit(f"{' '.join(map(str, command))} failed ({result.returncode})\n{result.stdout or ''}")
    return result


def git(repo, *args, **kwargs):
    return run("git", "-C", str(repo), *args, **kwargs)


def out(repo, *args):
    return git(repo, *args, capture=True).stdout.strip()


def latest_release():
    answer = run("npm", "view", "@gpuix/native", "version", capture=True).stdout.strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", answer):
        raise SystemExit(f"unexpected npm answer: {answer!r}")
    return answer


def fork_pin():
    pin = {}
    for line in (NATIVE / "FORK").read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            key, value = line.split("=", 1)
            pin[key.strip()] = value.strip()
    return pin


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


def replay(repo: Path, onto: str, base: str, head: str):
    """Rebase base..head onto `onto` in repo's worktree, through conflicts.

    Returns (clean commit count, commit count, [(subject, [files])] for each
    commit that conflicted). The result is a valid tree only when nothing did.
    """
    total = int(out(repo, "rev-list", "--count", f"{base}..{head}"))
    git(repo, "checkout", "-q", "--force", "--detach", head)
    conflicts = []
    result = git(repo, "rebase", "-q", "--onto", onto, base, capture=True, check=False)
    while result.returncode:
        stopped = git(repo, "rev-parse", "-q", "--verify", "REBASE_HEAD", capture=True, check=False).stdout.strip()
        if not stopped:
            raise SystemExit(f"rebase failed in {repo} without stopping at a commit:\n{result.stdout}")
        files = out(repo, "diff", "--name-only", "--diff-filter=U").split()
        conflicts.append((out(repo, "log", "-1", "--format=%h %s", stopped), files))
        # Keep our commit's side of each conflicted file and go on, so later commits
        # report only their own collisions with upstream instead of this one's fallout.
        for name in files:
            if git(repo, "checkout", "-q", "--theirs", "--", name, capture=True, check=False).returncode:
                git(repo, "rm", "-q", "--", name, capture=True, check=False)
            else:
                git(repo, "add", "--", name)
        result = git(repo, "-c", "core.editor=true", "rebase", "--continue", capture=True, check=False)
    return total - len(conflicts), total, conflicts


def napi_in(repo: Path, rev: str, prefix: str):
    names = set()
    for name in out(repo, "ls-tree", "-r", "--name-only", rev, prefix).split():
        if name.endswith(".rs"):
            names |= set(NAPI_FN.findall(out(repo, "show", f"{rev}:{name}")))
    return names


def our_methods(repo: Path, base: str, head: str):
    """`pub fn x(&self …)` methods our commits add to the native crate."""
    names = set()
    diff = out(repo, "diff", "--unified=0", f"{base}..{head}", "--", "packages/native/src")
    current = ""
    for line in diff.splitlines():
        if line.startswith("+++ "):
            current = line[4:]
        elif line.startswith("+") and not Path(current).name.startswith("rich_"):
            names |= set(OWN_METHOD.findall(line[1:]))
    return names


def duplicates(repo: Path, tag: str):
    """Names our commits define a second time in a file that already exports them."""
    repeated = set()
    for path in (repo / "packages" / "native" / "src").rglob("*.rs"):
        relative = path.relative_to(repo).as_posix()
        before = git(repo, "show", f"{tag}:{relative}", capture=True, check=False)
        if before.returncode:
            continue  # a file of ours
        was = Counter(NAPI_FN.findall(before.stdout))
        now = Counter(NAPI_FN.findall(path.read_text()))
        repeated |= {name for name, count in now.items() if was[name] and count > was[name]}
    return repeated


def gitlink(repo: Path, rev: str, path: str = "zed"):
    entry = out(repo, "ls-tree", rev, path).split()
    return entry[2] if entry else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", help="release to test (default: latest on npm)")
    parser.add_argument("--ref", help="test this remorses/gpuix branch or commit instead of a release tag")
    parser.add_argument("--pinned", help="release in use (default: native/VERSION)")
    parser.add_argument("--report", help="write a markdown report here")
    parser.add_argument("--tree", help="write the rebased checkout here when it is clean")
    parser.add_argument("--keep", help="reuse and keep this work directory")
    args = parser.parse_args()

    pin = fork_pin()
    pinned = args.pinned or (NATIVE / "VERSION").read_text().strip()
    latest = args.ref or args.version or latest_release()
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

    if latest == pinned and not args.ref:
        finish("current", [f"GPUIX {pinned} is the latest release; nothing to check."])

    work = Path(args.keep) if args.keep else Path(tempfile.mkdtemp(prefix="gpuix-canary-"))
    work.mkdir(parents=True, exist_ok=True)
    gpuix = Path(args.tree).resolve() if args.tree else work / "gpuix"
    zed = work / "zed"
    try:
        old_tag = f"refs/tags/{pin['upstream']}"
        if not (gpuix / ".git").exists():
            gpuix.mkdir(parents=True, exist_ok=True)
            git(gpuix, "init", "-q")
            git(gpuix, "remote", "add", "fork", pin["repo"])
            git(gpuix, "remote", "add", "upstream", REPO)
        git(gpuix, "fetch", "-q", "--filter=blob:none", "fork", pin["commit"])
        git(gpuix, "fetch", "-q", "--filter=blob:none", "--no-tags", "upstream", f"+{old_tag}:{old_tag}")
        if args.ref:
            git(gpuix, "fetch", "-q", "--filter=blob:none", "--no-tags", "upstream", args.ref)
            new = out(gpuix, "rev-parse", "FETCH_HEAD")
            label = f"`{args.ref}` ({new[:9]})"
        else:
            new_tag = f"refs/tags/@gpuix/native@{latest}"
            git(gpuix, "fetch", "-q", "--filter=blob:none", "--no-tags", "upstream", f"+{new_tag}:{new_tag}")
            new = out(gpuix, "rev-parse", f"{new_tag}^{{commit}}")
            label = latest
        old = out(gpuix, "rev-parse", f"{old_tag}^{{commit}}")

        # zed first: the gpuix replay ends by pointing the submodule at its result.
        old_zed, new_zed = gitlink(gpuix, old), gitlink(gpuix, new)
        if not (zed / ".git").exists():
            zed.mkdir(parents=True, exist_ok=True)
            git(zed, "init", "-q")
            git(zed, "remote", "add", "fork", pin["repo"].replace("/gpuix.git", "/zed.git"))
            git(zed, "remote", "add", "upstream", ZED_REPO)
        git(zed, "fetch", "-q", "--filter=blob:none", "fork", pin["zed"])
        if new_zed == old_zed:
            zed_result = (0, 0, [])
            git(zed, "checkout", "-q", "--force", "--detach", pin["zed"])
        else:
            git(zed, "fetch", "-q", "--filter=blob:none", "upstream", new_zed)
            zed_result = replay(zed, new_zed, old_zed, pin["zed"])
        zed_head = out(zed, "rev-parse", "HEAD")

        gpuix_result = replay(gpuix, new, old, pin["commit"])
        # Our last commit points the submodule at the zed fork. Redo it on the rebased
        # tree (the upstream gitlink move makes it conflict whenever zed moved).
        git(gpuix, "config", "-f", ".gitmodules", "submodule.zed.url", pin["repo"].replace("/gpuix.git", "/zed.git"))
        git(gpuix, "config", "-f", ".gitmodules", "submodule.zed.branch", "kybern")
        git(gpuix, "update-index", "--cacheinfo", f"160000,{zed_head},zed")
        gpuix_result = (gpuix_result[0], gpuix_result[1],
                        [c for c in gpuix_result[2] if not c[0].split(" ", 1)[1].startswith("Use the Tresnanda/zed")])

        problems = {}
        packages = work / "npm"
        shutil.rmtree(packages, ignore_errors=True)
        # A branch or commit has no npm packages to patch; only a release does.
        for name, script in () if args.ref else (("native", "patch_js.py"), ("react", "patch_react.py")):
            target = packages / name
            target.mkdir(parents=True)
            run("npm", "pack", "--ignore-scripts", "--silent", f"@gpuix/{name}@{latest}", cwd=target)
            tarball = next(target.glob("*.tgz"))
            run("tar", "-xzf", str(tarball), "-C", str(target))
            result = run(sys.executable, "-I", str(PATCHES / script), str(target / "package"), "--check", capture=True, check=False)
            if result.returncode not in (0, 1):
                raise SystemExit(f"{script} --check crashed:\n{result.stdout}")
            problems[f"JS patch for @gpuix/{name} ({script})"] = hook_problems(result.stdout)

        added = napi_in(gpuix, new, "packages/native/src") - napi_in(gpuix, old, "packages/native/src")
        clashes = sorted(added & our_methods(gpuix, old, pin["commit"]))
        repeated = sorted(duplicates(gpuix, new))

        lines = [f"## GPUIX {label} against the Kybern fork for {pinned}", ""]
        conflicted = False
        for title, (applied, total, conflicts), base in (
            ("gpuix commits (Tresnanda/gpuix kybern)", gpuix_result, None),
            ("zed commits (Tresnanda/zed kybern)", zed_result, new_zed == old_zed),
        ):
            if base:
                lines.append(f"### {title}: the release keeps zed at {old_zed[:9]}, nothing to rebase")
            elif conflicts:
                conflicted = True
                lines.append(f"### {title}: {len(conflicts)} of {total} conflict")
                for subject, files in conflicts:
                    lines.append(f"- `{subject}`: " + ", ".join(f"`{f}`" for f in files))
            else:
                lines.append(f"### {title}: all {total} rebase cleanly")
            lines.append("")
        for title, items in problems.items():
            lines.append(f"### {title}: {len(items)} missing or duplicated anchor(s)" if items else f"### {title}: all anchors match")
            for item in items:
                first, *rest = item.split("\n")
                lines.append(f"- `{first}`" + ("".join(f"\n  - {line}" for line in rest)))
            lines.append("")
        lines.append("### napi method names")
        lines.append(f"- {len(added)} method(s) are new in {label}: " + (", ".join(f"`{n}`" for n in sorted(added)) or "none"))
        if clashes:
            lines.append("- **also defined by a commit of ours (drop ours and use upstream's, or rename):** " + ", ".join(f"`{n}`" for n in clashes))
        if repeated:
            lines.append("- **defined twice in the rebased tree:** " + ", ".join(f"`{n}`" for n in repeated))
        if not (clashes or repeated):
            lines.append("- no clash with a method our commits define")
        lines.append("")
        broken = bool(conflicted or clashes or repeated or any(problems.values()))
        if broken:
            lines.append(
                "Rebase the forks' `kybern` branches onto %s and resolve the commits above (README.md, "
                "\"Moving to a new GPUIX release\"). The check is static: a clean report still needs a build "
                "to catch type errors." % label)
        else:
            lines.append("Our commits rebase cleanly and no names clash. Move the forks to %s and pin them "
                         "(README.md, \"Moving to a new GPUIX release\")." % label)
            if args.tree:
                # Put the rebased zed checkout where the submodule lives.
                shutil.rmtree(gpuix / "zed", ignore_errors=True)
                git(zed, "worktree", "add", "-q", "--force", "--detach", str(gpuix / "zed"), zed_head)
                lines.append(f"\nThe rebased checkout is in `{gpuix}`: `KYBERN_GPUIX_SOURCE={gpuix} ./update.sh {latest}`.")
        finish("broken" if broken else "compatible", lines)
    finally:
        if not args.keep:
            # --tree keeps the zed objects its worktree needs.
            if not args.tree:
                shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()

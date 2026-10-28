# Reviewed consolidated memory follow-up

See [REPORT.md](REPORT.md) for reviewed changes, measured results, and remaining acceptance gaps; [NATIVE_MEASUREMENT.md](NATIVE_MEASUREMENT.md) for reproduction; and [PR_DRAFT.md](PR_DRAFT.md) for the proposed pull request.

The implementation is in the repository, not in a replacement installer. The supplied installer and archive were inspected and preserved unchanged. This directory contains measurements from the actual release daemon and production-CSP WKWebView fixtures, not Python estimates of RAM.

Machine-readable evidence: [environment](environment.json), [daemon runs](daemon-comparison.json), [cold fold timings](fold-profile.jsonl), [native checkpoints](native-memory.json), and [identical terminal bundle hashes](terminal-bundle-comparison.json). Full local logs and per-stage vmmap summaries are retained in the original checkout under `perf-artifacts/memory-followup-20260917/`.

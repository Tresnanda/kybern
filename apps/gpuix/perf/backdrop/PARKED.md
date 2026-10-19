# Validation finished

The resumed lane is finished. See [RESULTS.md](RESULTS.md) for measurements, limits, checks and cleanup. The overall smoothness gate remains partial; this is a limited kernel GPU optimization.

Validated addon SHA256: `1f4180ed30dfa47124b10b621a3fa1753aa84d43164fc86458ce5f8cb4ddd88b`. Native target/upstream/dependencies and owned scratch data have been removed. Retain the addon, webview bridge and unique `backdrop-before.node` reference. Re-running native checks requires a fresh full build under the shared markers/leases and hidden-display guards.

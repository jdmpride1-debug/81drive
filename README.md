# 81drive.com performance audit

Tooling to measure how fast <https://81drive.com/> loads for visitors in the
United States, and to track that number over time.

## Why GitHub Actions

GitHub-hosted runners sit in US data centres, so a Lighthouse run from a runner
approximates a US visitor far better than a run from Japan would. The workflow
prints the runner's public IP/geo at the start of each run so the vantage point
is verifiable.

## What it measures

`.github/workflows/perf-audit.yml` runs on push to `claude/**`, weekly on
Mondays, and on demand via **Actions → Performance audit (US) → Run workflow**.

Each run produces:

- **Connection timing** (`scripts/curl-timing.sh`) — DNS, TCP, TLS, TTFB and
  total transfer time, cold and warm, plus compression and CDN cache headers.
- **Lighthouse**, 3 runs each for mobile and desktop, reported as medians:
  FCP, LCP, Speed Index, TBT, TTI, TTFB and CLS.
- **Page weight** broken down by resource type, and the 20 heaviest requests.
- **Ranked opportunities** — Lighthouse's own estimate of the time each fix saves.

Results appear in the job summary, and the full HTML reports are attached to the
run as the `lighthouse-reports` artifact.

## Targets

| Milestone | LCP (mobile, throttled) |
|---|---|
| Phase 1 | under 2.0s |
| Phase 2 | under 1.0s |

Lighthouse's mobile preset deliberately throttles to slow 4G with a 4x CPU
slowdown, so its numbers run notably worse than a real desktop visit. Treat the
desktop figure as the optimistic case and the mobile figure as the target to beat.

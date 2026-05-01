#!/usr/bin/env bash
# Static analysis health-score baseline runner.
#
# CI-invocable, deterministic, no interactive prompts. Same code in -> same
# JSON out. Designed to be the single entrypoint for both local developers
# and the CI pipeline.
#
# Usage:
#   tools/static-analysis/run-analysis.sh                # writes artifacts/health-score-baseline.json
#   tools/static-analysis/run-analysis.sh --out path.json
#
# Exit codes:
#   0  success (does NOT fail on baseline violations — that gate lives in a
#      future ticket once the cleanup milestones have improved the score)
#   1  scanner error (e.g. node missing, unreadable source tree)
#
# Tool selection rationale (see docs/architecture/health-metrics.md):
#   * NDepend CLI — preferred when licensed; not licensed for this repo.
#   * SonarScanner — requires SonarQube/SonarCloud connection; CI cannot
#     reach external services in the sandboxed worker, so it would fail
#     non-deterministically. Adopt later if/when CI gains internet egress.
#   * dotnet build /warnaserror with Roslyn analyzers — preferred next step
#     once dotnet is provisioned in the worker image. The current container
#     has no `dotnet` binary, so we fall back to a pure-Node Roslyn-equivalent
#     pattern scanner that emits the same JSON shape.
#
# The output JSON is intentionally generic (rule id + file path + severity)
# so swapping to NDepend / SonarScanner later is a low-cost change for any
# downstream consumer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

OUT_FILE="artifacts/health-score-baseline.json"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT_FILE="$2"
      shift 2
      ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required to run the static analyzer but was not found on PATH." >&2
  echo "Install Node 18+ in the CI image, or swap to dotnet build /warnaserror once dotnet is available." >&2
  exit 1
fi

cd "$REPO_ROOT"
node "$SCRIPT_DIR/analyze.js" --repo "$REPO_ROOT" --out "$OUT_FILE"

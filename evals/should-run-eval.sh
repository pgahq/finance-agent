#!/usr/bin/env bash
set -euo pipefail

PATTERN='^(evals/|src/lib/(ai|rag|invoice_lines|workday_validation_field_agent|database)\.ts|src/prompts/)'

git fetch origin main --depth=1 2>/dev/null || true

BASE="${EVAL_BASE_REF:-origin/main}"
if git rev-parse --verify "$BASE" >/dev/null 2>&1; then
  CHANGED=$(git diff --name-only "$BASE"...HEAD)
else
  CHANGED=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || git diff --name-only HEAD)
fi

if echo "$CHANGED" | grep -Eq "$PATTERN"; then
  echo "AI-related changes detected — running live evals"
  exit 0
fi

echo "No AI-related changes since $BASE — skipping live evals"
exit 1

#!/usr/bin/env bash
set -euo pipefail

# Publishes the Gmail Workspace add-on deployment for this stack.
# Does not run `gcloud workspace-add-ons deployments install` (that is per user).

KEY="${GCP_SERVICE_ACCOUNT_KEY:-${GCLOUD_SERVICE_KEY:-}}"
PROJECT="finance-agent-506013"
ENVIRONMENT="${ADDON_ENVIRONMENT:-}"
URL="${GMAIL_ADDON_URL:-}"

if [[ -z "${KEY}" ]]; then
  echo "Skipping Gmail add-on gcloud deploy; add GCP_SERVICE_ACCOUNT_KEY to this CircleCI context."
  exit 0
fi

if [[ -z "${ENVIRONMENT}" || -z "${URL}" ]]; then
  echo "Gmail add-on gcloud deploy needs ADDON_ENVIRONMENT and GMAIL_ADDON_URL." >&2
  exit 1
fi

NAME="$(node scripts/build-gmail-addon-deployment.js --environment "${ENVIRONMENT}" --print-id)"
FILE="$(mktemp)"
key_file="$(mktemp)"
cleanup() { rm -f "${FILE}" "${key_file}"; }
trap cleanup EXIT

echo "Building Workspace add-on deployment ${NAME} for ${ENVIRONMENT} at ${URL}"
node scripts/build-gmail-addon-deployment.js \
  --environment "${ENVIRONMENT}" \
  --url "${URL}" \
  --out "${FILE}"

case "${KEY}" in
  \{*) printf '%s' "${KEY}" > "${key_file}" ;;
  *) printf '%s' "${KEY}" | base64 -d > "${key_file}" ;;
esac

gcloud auth activate-service-account --key-file="${key_file}" --quiet
gcloud config set project "${PROJECT}" --quiet

if gcloud workspace-add-ons deployments describe "${NAME}" --project="${PROJECT}" >/dev/null 2>&1; then
  echo "Replacing Workspace add-on deployment ${NAME}"
  gcloud workspace-add-ons deployments replace "${NAME}" \
    --deployment-file="${FILE}" \
    --project="${PROJECT}" \
    --quiet
else
  echo "Creating Workspace add-on deployment ${NAME}"
  gcloud workspace-add-ons deployments create "${NAME}" \
    --deployment-file="${FILE}" \
    --project="${PROJECT}" \
    --quiet
fi

#!/usr/bin/env bash
set -euo pipefail

# Publishes the Gmail Workspace add-on deployment for this stack.
# Does not run `gcloud workspace-add-ons deployments install` (that is per user).

KEY="${GCP_SERVICE_ACCOUNT_KEY:-${GCLOUD_SERVICE_KEY:-}}"
PROJECT="${GCP_PROJECT_ID:-${GOOGLE_PROJECT_ID:-}}"
NAME="${GMAIL_ADDON_DEPLOYMENT_NAME:-}"
FILE="${GMAIL_ADDON_DEPLOYMENT_FILE:-}"
URL="${GMAIL_ADDON_URL:-}"

if [[ -z "${KEY}" && -z "${PROJECT}" ]]; then
  echo "Skipping Gmail add-on gcloud deploy; add GCP_SERVICE_ACCOUNT_KEY and GCP_PROJECT_ID to this CircleCI context."
  exit 0
fi

if [[ -z "${KEY}" || -z "${PROJECT}" || -z "${NAME}" || -z "${FILE}" || -z "${URL}" ]]; then
  echo "Gmail add-on gcloud deploy needs GCP_SERVICE_ACCOUNT_KEY, GCP_PROJECT_ID, GMAIL_ADDON_DEPLOYMENT_NAME, GMAIL_ADDON_DEPLOYMENT_FILE, and GMAIL_ADDON_URL." >&2
  exit 1
fi

if [[ ! -f "${FILE}" ]]; then
  echo "Gmail add-on deployment file not found: ${FILE}" >&2
  exit 1
fi

echo "Updating ${FILE} to ${URL}"
node scripts/set-gmail-addon-url.js "${FILE}" "${URL}"

key_file="$(mktemp)"
cleanup() { rm -f "${key_file}"; }
trap cleanup EXIT

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

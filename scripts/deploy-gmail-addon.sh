#!/usr/bin/env bash
set -euo pipefail

# Publishes the Gmail Workspace add-on deployment for this stack, or prints the
# project OAuth client ID used to verify add-on ID tokens.
# Does not run `gcloud workspace-add-ons deployments install` (that is per user).

ACTION="${1:-publish}"
KEY="${FINANCE_AGENT_GCP_SERVICE_ACCOUNT_KEY:-}"
PROJECT="finance-agent-506013"
ENVIRONMENT="${ADDON_ENVIRONMENT:-}"
URL="${GMAIL_ADDON_URL:-}"
TMP_FILES=()

cleanup() { rm -f "${TMP_FILES[@]}"; }
trap cleanup EXIT

ensure_gcloud() {
  if command -v gcloud >/dev/null 2>&1; then
    return
  fi
  curl -fsSL "https://dl.google.com/dl/cloudsdk/channels/rapid/google-cloud-sdk.tar.gz" \
    -o /tmp/google-cloud-sdk.tar.gz
  tar -C "$HOME" -xzf /tmp/google-cloud-sdk.tar.gz
  export PATH="$HOME/google-cloud-sdk/bin:${PATH}"
}

activate_gcloud() {
  if [[ -z "${KEY}" ]]; then
    echo "FINANCE_AGENT_GCP_SERVICE_ACCOUNT_KEY is required for gcloud." >&2
    exit 1
  fi

  ensure_gcloud
  local key_file
  key_file="$(mktemp)"
  TMP_FILES+=("${key_file}")

  case "${KEY}" in
    \{*) printf '%s' "${KEY}" > "${key_file}" ;;
    *) printf '%s' "${KEY}" | base64 -d > "${key_file}" ;;
  esac

  gcloud auth activate-service-account --key-file="${key_file}" --quiet
  gcloud config set project "${PROJECT}" --quiet
}

print_oauth_client_id() {
  activate_gcloud
  local client_id
  client_id="$(gcloud workspace-add-ons get-authorization \
    --project="${PROJECT}" \
    --format='value(oauthClientId)')"
  if [[ -z "${client_id}" ]]; then
    echo "gcloud workspace-add-ons get-authorization returned an empty oauthClientId. Configure the OAuth consent screen in ${PROJECT}." >&2
    exit 1
  fi
  printf '%s\n' "${client_id}"
}

publish_deployment() {
  if [[ -z "${KEY}" ]]; then
    echo "Skipping Gmail add-on gcloud deploy; add FINANCE_AGENT_GCP_SERVICE_ACCOUNT_KEY to this CircleCI context."
    exit 0
  fi

  if [[ -z "${ENVIRONMENT}" || -z "${URL}" ]]; then
    echo "Gmail add-on gcloud deploy needs ADDON_ENVIRONMENT and GMAIL_ADDON_URL." >&2
    exit 1
  fi

  local name file
  name="$(node scripts/build-gmail-addon-deployment.js --environment "${ENVIRONMENT}" --print-id)"
  file="$(mktemp)"
  TMP_FILES+=("${file}")

  echo "Building Workspace add-on deployment ${name} for ${ENVIRONMENT} at ${URL}"
  node scripts/build-gmail-addon-deployment.js \
    --environment "${ENVIRONMENT}" \
    --url "${URL}" \
    --out "${file}"

  activate_gcloud

  if gcloud workspace-add-ons deployments describe "${name}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "Replacing Workspace add-on deployment ${name}"
    gcloud workspace-add-ons deployments replace "${name}" \
      --deployment-file="${file}" \
      --project="${PROJECT}" \
      --quiet
  else
    echo "Creating Workspace add-on deployment ${name}"
    gcloud workspace-add-ons deployments create "${name}" \
      --deployment-file="${file}" \
      --project="${PROJECT}" \
      --quiet
  fi
}

case "${ACTION}" in
  print-oauth-client-id)
    print_oauth_client_id
    ;;
  publish)
    publish_deployment
    ;;
  *)
    echo "Usage: $0 [publish|print-oauth-client-id]" >&2
    exit 1
    ;;
esac

#!/usr/bin/env bash
set -Eeuo pipefail

: "${BACKEND_IMAGE:?BACKEND_IMAGE is required}"
: "${FRONTEND_IMAGE:?FRONTEND_IMAGE is required}"
: "${TARGET_SHA:?TARGET_SHA is required}"
: "${CHANNEL:?CHANNEL is required}"

REGCTL_BIN="${REGCTL_BIN:-regctl}"
GH_BIN="${GH_BIN:-gh}"
PROMOTE_MAX_ATTEMPTS="${PROMOTE_MAX_ATTEMPTS:-3}"
PROMOTE_RETRY_SLEEP_SECONDS="${PROMOTE_RETRY_SLEEP_SECONDS:-2}"

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "TARGET_SHA must be a full lowercase Git SHA" >&2
  exit 1
}
[[ "$PROMOTE_MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || {
  echo "PROMOTE_MAX_ATTEMPTS must be a positive integer" >&2
  exit 1
}
[[ "$PROMOTE_RETRY_SLEEP_SECONDS" =~ ^[0-9]+$ ]] || {
  echo "PROMOTE_RETRY_SLEEP_SECONDS must be a non-negative integer" >&2
  exit 1
}

target_tag="${VERSION_TAG:-}"
case "$CHANNEL" in
  edge)
    : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required for edge promotion}"
    current_main_sha="$($GH_BIN api "repos/${GITHUB_REPOSITORY}/commits/main" --jq .sha)"
    if [[ "$current_main_sha" != "$TARGET_SHA" ]]; then
      echo "Skipping stale edge promotion for $TARGET_SHA; current main is $current_main_sha."
      exit 0
    fi
    target_tag="edge"
    ;;
  semver)
    [[ "$target_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
      echo "Semver promotion requires VERSION_TAG=vX.Y.Z" >&2
      exit 1
    }
    ;;
  *)
    echo "Unsupported promotion channel: $CHANNEL" >&2
    exit 1
    ;;
esac

images=("$BACKEND_IMAGE" "$FRONTEND_IMAGE")
source_digests=()
old_digests=()
missing_digest="__MISSING__"

list_tags() {
  "$REGCTL_BIN" tag ls "$1" --format '{{ range .Tags }}{{ println . }}{{ end }}'
}

for image in "${images[@]}"; do
  source_digest="$($REGCTL_BIN image digest "${image}:sha-${TARGET_SHA}")"
  [[ "$source_digest" =~ ^sha256:[0-9A-Za-z._-]+$ ]] || {
    echo "Invalid source digest for ${image}:sha-${TARGET_SHA}: $source_digest" >&2
    exit 1
  }
  source_digests+=("$source_digest")

  tags="$(list_tags "$image")"
  if grep -Fqx -- "$target_tag" <<<"$tags"; then
    old_digest="$($REGCTL_BIN image digest "${image}:${target_tag}")"
    [[ "$old_digest" =~ ^sha256:[0-9A-Za-z._-]+$ ]] || {
      echo "Invalid existing digest for ${image}:${target_tag}: $old_digest" >&2
      exit 1
    }
    old_digests+=("$old_digest")
  else
    old_digests+=("$missing_digest")
  fi
done

run_with_retries() {
  local attempt
  for ((attempt = 1; attempt <= PROMOTE_MAX_ATTEMPTS; attempt += 1)); do
    if "$@"; then
      return 0
    fi
    if ((attempt < PROMOTE_MAX_ATTEMPTS)); then
      sleep "$((PROMOTE_RETRY_SLEEP_SECONDS * attempt))"
    fi
  done
  return 1
}

rollback_pair() {
  local failed=0
  local image
  local old_digest
  local tags
  local restored_digest
  local index

  echo "Promotion failed; restoring both ${target_tag} references." >&2
  for index in "${!images[@]}"; do
    image="${images[$index]}"
    old_digest="${old_digests[$index]}"
    if [[ "$old_digest" == "$missing_digest" ]]; then
      if ! run_with_retries \
        "$REGCTL_BIN" tag delete --ignore-missing "${image}:${target_tag}"; then
        echo "Failed to remove new tag ${image}:${target_tag}" >&2
        failed=1
      fi
    elif ! run_with_retries \
      "$REGCTL_BIN" image copy "${image}@${old_digest}" "${image}:${target_tag}"; then
      echo "Failed to restore ${image}:${target_tag} to ${old_digest}" >&2
      failed=1
    fi
  done

  for index in "${!images[@]}"; do
    image="${images[$index]}"
    old_digest="${old_digests[$index]}"
    if ! tags="$(list_tags "$image")"; then
      echo "Failed to verify tags for $image after rollback" >&2
      failed=1
      continue
    fi
    if [[ "$old_digest" == "$missing_digest" ]]; then
      if grep -Fqx -- "$target_tag" <<<"$tags"; then
        echo "New tag ${image}:${target_tag} remains after rollback" >&2
        failed=1
      fi
      continue
    fi
    if ! restored_digest="$($REGCTL_BIN image digest "${image}:${target_tag}")"; then
      echo "Failed to read restored digest for ${image}:${target_tag}" >&2
      failed=1
    elif [[ "$restored_digest" != "$old_digest" ]]; then
      echo "Rollback digest mismatch for ${image}:${target_tag}" >&2
      failed=1
    fi
  done
  return "$failed"
}

promotion_committed="false"
on_exit() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$promotion_committed" != "true" ]]; then
    if ! rollback_pair; then
      echo "CRITICAL: GHCR pair rollback did not restore the previous state." >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

for index in "${!images[@]}"; do
  image="${images[$index]}"
  source_digest="${source_digests[$index]}"
  run_with_retries \
    "$REGCTL_BIN" image copy "${image}@${source_digest}" "${image}:${target_tag}"
  promoted_digest="$($REGCTL_BIN image digest "${image}:${target_tag}")"
  [[ "$promoted_digest" == "$source_digest" ]] || {
    echo "Promotion digest mismatch for ${image}:${target_tag}" >&2
    exit 1
  }
done

promotion_committed="true"
echo "Promoted backend/frontend image pair to ${target_tag} from ${TARGET_SHA}."

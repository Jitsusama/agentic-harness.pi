#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") <owner> <project-number>

Resolve a GitHub Projects v2 number to its node ID.

Tries organization lookup first, then falls back to user lookup.

Arguments:
  owner            Organization or user that owns the project
  project-number   The project number (visible in the project URL)

Requires: gh CLI authenticated.

Examples:
  $(basename "$0") Shopify 13140
  $(basename "$0") my-user 5
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 2 ]]; then
  echo "Error: missing arguments" >&2
  usage >&2
  exit 1
fi

owner="$1"
project_number="$2"

# Try organization first
result=$(gh api graphql -f query="
query {
  organization(login: \"$owner\") {
    projectV2(number: $project_number) {
      id
      title
    }
  }
}" 2>/dev/null | jq -r '.data.organization.projectV2 // empty') || true

if [[ -n "$result" && "$result" != "null" ]]; then
  echo "$result" | jq '{id, title, type: "organization"}'
  exit 0
fi

# Fall back to user
result=$(gh api graphql -f query="
query {
  user(login: \"$owner\") {
    projectV2(number: $project_number) {
      id
      title
    }
  }
}" 2>/dev/null | jq -r '.data.user.projectV2 // empty') || true

if [[ -n "$result" && "$result" != "null" ]]; then
  echo "$result" | jq '{id, title, type: "user"}'
  exit 0
fi

echo "Error: could not find project $project_number for owner $owner" >&2
exit 1

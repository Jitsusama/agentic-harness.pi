#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") <owner> <project-number>

List items in a GitHub Projects v2 board.

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

gh project item-list "$project_number" --owner "$owner" --format json \
  | jq '.items[] | {number: .content.number, id: .id, title: .title, status: .status}'

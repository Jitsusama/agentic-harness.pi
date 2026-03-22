#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") <project-id> <item-id> [after-id]

Reposition an item within a GitHub Projects v2 board.

Arguments:
  project-id   Node ID of the project (PVT_kwD...)
  item-id      Node ID of the item to move (PVTI_lAD...)
  after-id     Node ID of the item to position after (optional)
               Omit to move to the top of the list.

Requires: gh CLI authenticated.

Examples:
  # Move item after another item
  $(basename "$0") PVT_kwDabc PVTI_lADdef PVTI_lADghi

  # Move item to the top
  $(basename "$0") PVT_kwDabc PVTI_lADdef
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

project_id="$1"
item_id="$2"
after_id="${3:-}"

if [[ -n "$after_id" ]]; then
  after_clause="afterId: \"$after_id\""
else
  after_clause=""
fi

gh api graphql -f query="
mutation {
  updateProjectV2ItemPosition(input: {
    projectId: \"$project_id\"
    itemId: \"$item_id\"
    $after_clause
  }) {
    clientMutationId
  }
}" | jq '.data.updateProjectV2ItemPosition'

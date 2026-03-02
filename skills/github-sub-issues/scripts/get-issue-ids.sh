#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") <owner> <repo> <numbers-or-labels>

Resolve GitHub issue numbers to node IDs, or list issues by label.

Arguments:
  owner              Repository owner (org or user)
  repo               Repository name
  numbers-or-labels  Comma-separated issue numbers (e.g. "42,43,44")
                     or a label filter (e.g. "label:my-label")

Requires: gh CLI authenticated.

Examples:
  # By issue numbers
  $(basename "$0") Shopify accio "42,43,44"

  # By label
  $(basename "$0") Shopify accio "label:privacy-eng"
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 3 ]]; then
  echo "Error: missing arguments" >&2
  usage >&2
  exit 1
fi

owner="$1"
repo="$2"
filter="$3"

if [[ "$filter" == label:* ]]; then
  # Label-based search
  label="${filter#label:}"
  gh issue list --repo "$owner/$repo" \
    --search "label:$label" \
    --json number,id,title \
    --limit 100 \
    | jq '.[] | {number, id, title}'
else
  # Number-based lookup
  IFS=',' read -ra numbers <<< "$filter"
  for num in "${numbers[@]}"; do
    num="$(echo "$num" | tr -d ' ')"
    gh issue view "$num" --repo "$owner/$repo" --json number,id,title \
      | jq '{number, id, title}'
  done
fi

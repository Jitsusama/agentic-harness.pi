#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") <owner> <repo> <issue-number>

List sub-issues of a parent GitHub issue.

Arguments:
  owner          Repository owner (org or user)
  repo           Repository name
  issue-number   Parent issue number

Requires: gh CLI authenticated, GraphQL-Features: sub_issues header.

Examples:
  $(basename "$0") Shopify accio 42
  $(basename "$0") my-org my-repo 100
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
number="$3"

gh api graphql \
  -H "GraphQL-Features: sub_issues" \
  -f query='
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id
      title
      subIssues(first: 50) {
        nodes {
          id
          number
          title
          state
        }
      }
    }
  }
}' -f owner="$owner" -f repo="$repo" -F number="$number" \
  | jq '.data.repository.issue | {
      id: .id,
      title: .title,
      subIssues: [.subIssues.nodes[] | {id, number, title, state}]
    }'

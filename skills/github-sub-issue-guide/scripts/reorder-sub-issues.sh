#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") <parent-id> <sub-issue-id> [after-id]

Reposition a sub-issue within its parent issue.

Arguments:
  parent-id      Node ID of the parent issue (I_kwDO...)
  sub-issue-id   Node ID of the sub-issue to move (I_kwDO...)
  after-id       Node ID of the sub-issue to position after (optional)
                 Omit to move to the top of the list.

Requires: gh CLI authenticated, GraphQL-Features: sub_issues header.

Examples:
  # Move sub-issue after another sub-issue
  $(basename "$0") I_kwDOabc123 I_kwDOdef456 I_kwDOghi789

  # Move sub-issue to the top
  $(basename "$0") I_kwDOabc123 I_kwDOdef456
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

parent_id="$1"
sub_issue_id="$2"
after_id="${3:-}"

if [[ -n "$after_id" ]]; then
  after_clause="afterId: \"$after_id\""
else
  after_clause=""
fi

gh api graphql \
  -H "GraphQL-Features: sub_issues" \
  -f query="
mutation {
  reprioritizeSubIssue(input: {
    issueId: \"$parent_id\"
    subIssueId: \"$sub_issue_id\"
    $after_clause
  }) {
    issue { title }
  }
}" | jq '.data.reprioritizeSubIssue.issue'

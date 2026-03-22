---
name: github-sub-issue-guide
description: >
  Managing sub-issues in GitHub Issues. Query, reorder, and create
  sub-issues using the GraphQL API. Use when working with parent/child
  issue relationships or reordering sub-issues within an epic.
---

# GitHub Sub-Issues

GitHub Issues supports parent/child relationships via sub-issues.
These are managed through GraphQL mutations that require a special
header.

## Critical Requirement

All sub-issue GraphQL calls **must** include this header:

```
GraphQL-Features: sub_issues
```

Without it, the API silently ignores sub-issue fields and mutations.

## Querying Sub-Issues

List sub-issues of a parent issue:

```bash
gh api graphql \
  -H "GraphQL-Features: sub_issues" \
  -f query='
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
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
}' -f owner="OWNER" -f repo="REPO" -F number=NUMBER
```

Or use the helper script:

```bash
./scripts/query-sub-issues.sh <owner> <repo> <issue-number>
```

## Reordering Sub-Issues

Use the `reprioritizeSubIssue` mutation to reposition a sub-issue
within its parent:

```bash
gh api graphql \
  -H "GraphQL-Features: sub_issues" \
  -f query='
mutation {
  reprioritizeSubIssue(input: {
    issueId: "I_kwDO..."        # Parent issue node ID
    subIssueId: "I_kwDO..."     # Sub-issue to move
    afterId: "I_kwDO..."        # Position after this sub-issue
  }) {
    issue { title }
  }
}'
```

Or use the helper script:

```bash
./scripts/reorder-sub-issues.sh <parent-id> <sub-issue-id> [after-id]
```

- `afterId` is optional; omit it to move the sub-issue to the top
- For bulk reordering, iterate through the list and position each
  after the previous
- Add 0.2–0.5 second delays between calls to avoid rate limiting

## Getting Issue Node IDs

Issue IDs (format `I_kwDO...`) are required for mutations. Resolve
them from issue numbers:

```bash
gh issue list --repo owner/repo --json number,id
```

Or filter by label:

```bash
gh issue list --repo owner/repo --search "label:my-label" --json number,id
```

Or use the helper script:

```bash
./scripts/get-issue-ids.sh <owner> <repo> <numbers-or-labels>
```

## Helper Scripts

Scripts are in the `scripts/` directory relative to this skill.
Each accepts `--help` for usage information. They wrap the GraphQL
calls above with error handling and formatted output.

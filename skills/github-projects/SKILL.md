---
name: github-projects
description: >
  Managing items in GitHub Projects v2. Query project items, reorder
  them, and resolve project IDs. Use when working with GitHub project
  boards or reordering items in a project.
---

# GitHub Projects v2

GitHub Projects v2 uses a GraphQL API for managing project items
and their positions.

## Key ID Formats

- **Project IDs** start with `PVT_kwD...`
- **Project Item IDs** start with `PVTI_lAD...`
- No special headers needed (unlike sub-issues)

## Querying Project Items

List items in a project:

```bash
gh project item-list <project-number> --owner <owner> --format json \
  | jq '.items[] | {number: .content.number, id: .id, title: .title}'
```

Or use the helper script:

```bash
./scripts/query-project-items.sh <owner> <project-number>
```

## Reordering Project Items

Use the `updateProjectV2ItemPosition` mutation to reposition an
item within a project:

```bash
gh api graphql -f query='
mutation {
  updateProjectV2ItemPosition(input: {
    projectId: "PVT_kwD..."     # Project node ID
    itemId: "PVTI_lAD..."       # Item to move
    afterId: "PVTI_lAD..."      # Position after this item
  }) {
    clientMutationId
  }
}'
```

Or use the helper script:

```bash
./scripts/reorder-project-item.sh <project-id> <item-id> [after-id]
```

- `afterId` is optional; omit it to move the item to the top
- Position items sequentially using `afterId` for bulk reordering
- Add 0.2–0.5 second delays between calls to avoid rate limiting

## Getting Project IDs

Resolve a project number to its node ID.

For organization projects:

```bash
gh api graphql -f query='
query($login: String!, $number: Int!) {
  organization(login: $login) {
    projectV2(number: $number) {
      id
      title
    }
  }
}' -f login="ORG" -F number=NUMBER
```

For user projects:

```bash
gh api graphql -f query='
query($login: String!, $number: Int!) {
  user(login: $login) {
    projectV2(number: $number) {
      id
      title
    }
  }
}' -f login="USER" -F number=NUMBER
```

Or use the helper script:

```bash
./scripts/get-project-id.sh <owner> <project-number>
```

The script tries organization first, then falls back to user.

## Helper Scripts

Scripts are in the `scripts/` directory relative to this skill.
Each accepts `--help` for usage information. They wrap the GraphQL
calls above with error handling and formatted output.

# PR Annotate Extension

Proposes inline self-review comments on a pull request for you
to vet before they're posted to GitHub.

## How It Works

The agent calls the `pr_annotate` tool with proposed comments.
The extension fetches the PR diff and presents a workspace panel
with file-based tabs matching pr-review's layout:

- **Summary tab**: comment counts, progress, file breakdown.
- **Per-file tabs** with three views:
  - `[o] Overview`: diff with comment indicators on annotated lines.
  - `[c] Comments`: selectable list, approve/reject per comment.
  - `[s] Source`: full file, syntax highlighted.

Tabs auto-complete when all their comments are resolved.
Ctrl+Enter posts approved comments as a single PR review.
Shift+S steers to give the agent feedback.

# PR Annotate Extension

Proposes inline self-review comments on a pull request for you
to vet before they're posted to GitHub.

## How It Works

The agent calls the `pr_annotate` tool with proposed comments. Each
comment is presented through an approval gate where you can approve,
edit, reject, or steer. Only approved comments are posted as a
single PR review via `gh api`.

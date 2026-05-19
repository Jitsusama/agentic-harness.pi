# PR Workflow Guide

Teaches the agent how to drive the `pr_workflow` tool: a
conversation-first PR review system with a multi-model
council pipeline (fan-out reviewers, judge consolidation,
optional critique, user synthesis) ending in a posted
GitHub review.

Activates when the user wants to look at, review or
comment on someone else's pull request. Pairs with
`code-review-standard` for evaluation criteria,
`comment-format` for comment shape and `prose-standard`
for written voice.

The skill maps user intent to tool actions: which action
to call when, what state each expects and how to keep the
user oriented across a multi-round pipeline.

For replying to feedback on your own PR, see
`pr_reply`. For self-annotating your own PR, see
`pr_annotate`.

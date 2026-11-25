# Review Tools

The review integration's tools and the steps each takes: `ask` for
councils and their line, `draft` for composing a review, `offer` for
proposing and merging, `see` and `read` for reading a change, and
`say` for answering on it. Each tool's registration is in its
`*-tool.ts`, and the files beside it, named by the same prefix, hold
its steps.

Many entries because each tool's steps change for their own reasons
(a council's line, a merge's gates, a draft's turns) and are files of
their own beside the tool they serve; the ask files, which are the
most and share the most, are the first to go to a folder of their own.

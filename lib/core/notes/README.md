# Core's Notes

A personal notes archive: one folder a note, named by its ID, with
a README.md and its attachments, all directly under a notes root.
`types.ts` holds a note's kinds and frontmatter. Reading and
writing notes on disk is in `lib/core/internal/notes`. There is no
barrel: core ran the verbs from a command line of its own, which
was not folded in, so nothing here calls them but their tests.

## Folders

- `verbs/`: what can be done to the archive, a module a group:
  create, the changes (retype, retitle, tag, reparent), the
  queries (find, show, tree, types) and reindex, which writes the
  root's INDEX.md, with the params and results they share.

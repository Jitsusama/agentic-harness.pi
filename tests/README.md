# Tests

The package's tests. They mirror the source: `extensions/` holds the tests
of `../extensions/`, `lib/` those of `../lib/`, `core/` those of
`../lib/core/`, and `packs/` and `scripts/` those of their namesakes, so
an extension's or a library's tests are found by its path.

The rest are folders of their own:

| Folder     | Holds                                                              |
| ---------- | ------------------------------------------------------------------ |
| `package/` | rules the whole package keeps, read across every file            |
| `screen/`  | pi itself on a terminal read back, for what only a real screen shows |
| `setup/`   | what vitest runs around every test: a sandboxed XDG tree, a temp root |
| `support/` | helpers several folders' tests share                              |

A helper one folder's tests need stays beside them, in a `support/` folder
of its own.

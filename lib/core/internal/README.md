# Core's Internal Library

What core's modules share and their barrels don't export. As in
`lib/internal`, there are no barrels: a caller imports the file it
needs. The harness's extensions and libraries import from here, but
nothing outside the package may, and any of it may change without
notice.

Three files sit at the top: `file-lock.ts`, an advisory lock around
one file's read-modify-write; `json-array.ts`, the first balanced
JSON array in a model's reply; and `oauth-redirect.ts`, the wait on
localhost for the redirect an OAuth login ends in.

## Folders

- `artifacts/`: ownership records and conservative reaping shared by stored
  tool results and captured web bundles.
- `github/`: parsing `gh pr` and `gh issue` create and edit
  commands for their action, title, body and number. The rules a
  body must keep are in `lib/core/github-cli`.
- `guardian/`: what the commit, history, PR and issue guardians
  decide with: commit message parsing and format rules, the
  destructive git commands, and the glue that runs the prose,
  section, title and redirect gates against a signature store.
- `lsp/`: the session-keyed editor registry and process-owned standalone
  pool that `lib/core/lsp/registry.ts` registers into and resolves from.
- `keyring/`: the desktop's secret store, the Secret Service keyring
  on Linux and the Keychain on macOS, as pi's own process reaches it,
  and the credentials documents kept there: the Google and Slack
  sign-ins, moved once from their plain files, which stay the
  fallback, said out loud, while the keyring can't be reached.
- `notes/`: the notes archive on disk: finding notes, their
  frontmatter, ids, atomic writes and safe file names. The verbs
  that use them are in `lib/core/notes/verbs`.
- `oauth-pages/`: the HTML and CSS a login's browser tab is shown
  when its redirect lands, filled in by `oauth-redirect.ts` with the
  service's name and any error.
- `quest/`: a quest's record and its workspace: which files the
  record holds, the gate and the audit that keep it so, and the
  workspace outside it for everything else. Beside them, what a
  write or a shell command touches, for the quest phase gate.
  The quest store's own types and I/O are in `lib/internal/quest`.
- `review/`: the process-global registry of review providers.
- `sqlite/`: the promise wrapper over the sqlite3 driver, and SQL
  read from `.sql` files, for the local stores.
- `terminal/`: the drivers, launchers and registry behind
  `lib/terminal`; its README says more.
- `tree/`: the tree provider registry and the built-in git-worktree
  provider; its README says more.

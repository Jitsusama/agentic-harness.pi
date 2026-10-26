# Pi's Packages as Dependencies

How this package declares the pi packages it imports, and why each
declaration is where it is. [AGENTS.md](../AGENTS.md) states the
rule in a line.

Imports from pi use `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai` and `@earendil-works/pi-tui`.
These are provided by pi at runtime; do not add them to
`dependencies`. They appear in three other places, each
for its own reason, and all three are enforced by
`tests/package/runtime-deps.test.ts`:
- `peerDependencies` at `"*"`, under the current
  `@earendil-works/*` names, because that is the
  relationship: pi hands these to an extension at load
  time, and which version is the host's business.
- `peerDependenciesMeta` marking every one optional,
  because npm installs a root package's peers otherwise
  and pi runs `npm install --omit=dev` on a git install.
  Measured: without the flag, one declaration pulled 189
  packages into a clean tree, among them a deprecated
  copy of pi's whole runtime three minor versions
  behind. A second copy of pi's modules is a different
  copy, and the instanceof checks in its own APIs stop
  holding.
- `devDependencies`, so `tsc` has the real declarations
  on disk. Naming the same packages here as in
  `peerDependencies` is also what stops pnpm installing
  its own: pnpm installs peers by default and ignores
  the optional flag, but it finds these already
  satisfied. Consumers never receive them, since
  `--omit=dev` skips the list entirely. Pin them to the
  pi version that runs, and pin the rest of the
  `@earendil-works` family to it under `pnpm.overrides`:
  pi's own manifest asks for its siblings with a caret,
  so a newer sibling arrives beside an older pi, and
  pi 1.1.0 would not import beside pi-codemode 1.2.0.
- `pnpm.onlyBuiltDependencies`, naming every dependency
  with a native build (sqlite3). pnpm 10 runs no
  dependency's install script that the package does not
  allow, and pi installs with whichever pnpm it finds, so
  on 26 October sqlite3 arrived without its binding.
  `pnpm load-check` fails when an install skips a build.

Pi's loader also aliases the older `@mariozechner/*`
spelling, which this repo imported until every site was
migrated. Do not reintroduce it: those packages are
published deprecated, pi's loader comment says the compat
aliases stay only until compat is removed, and the
`tsconfig.json` and vitest mappings that used to bridge
the two names are gone.

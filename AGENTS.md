## What This Is

A pi package — a collection of extensions and skills that other
people install into their pi setup. There is no build step, no
test suite, and no dependencies to install. Pi compiles TypeScript
at runtime.

## Structure

- `extensions/` — TypeScript modules that enforce guardrails
  (commit review, mode enforcement, UI components)
- `extensions/shared/` — utilities used across multiple extensions
- `skills/` — markdown instructions the agent loads on demand
  when a task matches their description

Extensions and skills are complementary. Skills teach methodology,
extensions enforce it. Some are paired (e.g. planning skill +
plan-mode extension) but all work independently.

## Conventions

- Each extension and skill directory has a README.md for humans.
- Extensions use JSDoc headers describing their purpose.
- Skills have a SKILL.md (loaded by pi) and a README.md (for
  browsing). Do not duplicate content between them.
- **Never put a README.md in the `skills/` root.** Pi treats any
  `.md` file there as a skill.
- Imports from pi use `@mariozechner/pi-coding-agent`,
  `@mariozechner/pi-ai`, and `@mariozechner/pi-tui`. These are
  provided by pi at runtime — do not add them to package.json.

## Testing Changes

Use `/reload` in a running pi session to pick up changes without
restarting. Use `pi -e ./extensions/some-ext` to test a single
extension in isolation.

## What Not to Do

- Do not add build tooling, bundlers, or transpilation steps.
- Do not add runtime dependencies to package.json. Pi provides
  all necessary imports.
- Do not create `.md` files directly in the `skills/` root
  (other than inside subdirectories).

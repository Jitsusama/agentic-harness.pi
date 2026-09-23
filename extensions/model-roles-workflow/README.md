# Model Roles Workflow

Registers `/model-roles`, which derives premium, primary and light per
provider from the live model registry, and names every model that a
same-family, cheaper-or-equal, newer sibling has made redundant.

## Why the Live Registry, Not a Settings File

`ctx.modelRegistry` answers for what is actually installed and priced
right now. A settings file on disk is a snapshot somebody wrote down
once, and drifts the moment a provider reprices or a new model lands.

## Archaic, Precisely

A model is archaic when some other model, same family (`claude-opus-4-5`
and `claude-opus-4-8` share the family `claude-opus`; a trailing
eight-digit segment is read as a pinned snapshot date, not a version
step), same provider namespace (`anthropic` and `anthropic-flex` are
not compared against each other, since they reach overlapping catalogs
differently), is strictly newer by version and no costlier on any of
input, output, cache read or cache write. An older model that is still
cheaper on some axis is a genuine tradeoff, not obsolescence, and is
left alone.

## Why This Needed No Gate

Everything else built for the wider spend plan that changes what a
model actually sees, or which one runs, ships behind a flag until there
is a way to measure the tradeoff. This does neither: it derives a
reading and shows it. Nothing here selects a model for anything yet,
which is why it is on by default.

## Files

- `index.ts`: registration and the command handler.
- `render.ts`: turns a derivation into panel lines. Untested, like
  every other Theme-dependent renderer in this package: the value
  worth testing is the derivation itself, in `lib/roles/`.

The derivation, `deriveRoles` and `findArchaic`, lives in `lib/roles/`,
since it needs nothing from pi and is exercised directly by its own
tests.

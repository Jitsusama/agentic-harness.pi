---
name: quest-convention
description: >
  Operational conventions for the quest system: when to use
  a quest versus a subquest versus a sidequest, when to
  scaffold a plan or research document, how to reorder
  priorities, when to add optional sections, when to
  conclude versus retire, the resuscitate pattern. Use
  when driving the quest tool, deciding kind, promoting or
  parking work, or organising a project as quests. Pairs
  with quest-format for the on-disk shape.
---

# Quest Convention

A quest is a campaign with a stable id, a title and a
narrative arc. A subquest is a campaign whose spirit
serves a parent quest. A sidequest is a small unit of
work that came in from outside the planned arc, often
from a Slack message or a GitHub issue.

The format skill teaches the shape; this skill teaches the
choices.

## Kind: Quest, Subquest or Sidequest

- **Quest**: a campaign of work with a north star that
  spans weeks or months. Top-level quests have
  `parent: null`. A project under
  `~/src/localhost/documents/projects/` becomes a top-level
  quest; their parent is the workspace itself, which we
  do not model.
- **Subquest**: a campaign whose existence depends on a
  parent quest's spirit. Subquests have `parent: <QEST-id>`.
  Useful for partitioning a large quest into independently
  trackable strands. Subquests sit flat at the quests
  root alongside their parent; the relationship lives in
  front-matter, never in directory nesting.
- **Sidequest**: a small or external unit of work,
  typically created from a Slack thread, a PR review or
  an incident. A free-standing sidequest has
  `parent: null` and sits alongside top-level quests; a
  scoped sidequest (a PR review under an active quest,
  say) carries the loaded quest's id as its parent so the
  audit trail composes. Either form is valid.

When in doubt, start as a sidequest and promote later. A
sidequest that grows a north star becomes a quest with
`reclassify`, which flips the loaded quest's kind in place.
Reclassifying to a subquest needs a parent to rank within,
so reparent it under a quest first if it has none.

## Priority Buckets and Rank

Priority is one of: `driving`, `active`, `queued`, `bench`,
`someday`. Each bucket is its own pool; the rank field
orders within the bucket.

- **driving**: the one or two quests you're carrying this
  week. Status-bar prominence.
- **active**: live work but not the headline.
- **queued**: ready to pick up.
- **bench**: parked deliberately. Will return.
- **someday**: aspirational. May never happen.

The importance verbs (`top`, `bottom`, `bump`, `sink`,
`before`, `after`, `renumber`) operate on rank within the
sibling set: quests rank globally; subquests rank within
their parent; sidequests rank globally.

Use `promote`, `demote`, `drive`, `park`, `defer` to move
between buckets. Use `top`/`bottom`/`bump`/`sink` to
reorder within one.

You never set rank by hand. Creating a quest, and moving one
to a new bucket, appends it at the next free rank in its
sibling set, so ranks stay distinct without a collision. The
listing sorts live quests ahead of sealed ones whatever their
priority, so a concluded quest never outranks live work.

## Status and Journey

Status is a coarse enum. Three values are reachable through
verbs: a quest is `active` from creation, and `conclude` and
`retire` seal it to `concluded` or `retired`; `reopen`
returns a sealed quest to `active`. The `paused` and
`blocked` values are reserved: the parser still accepts them
so legacy quests stay visible, but no verb sets them today.
Do not hand-edit a status into `paused` or `blocked`; use the
Journey log to record that the work is waiting.

Status is not where you write narrative. The narrative lives
in the Journey log: dated bullets, newest first, recording
what happened and why.

When asked "what is happening on QEST-X", the tool
synthesises a paragraph from frontmatter plus recent
Journey entries; you don't write status prose yourself.

## Creating from a URL

The dominant creation pattern: "look at this Slack thread"
or "create a sidequest for this PR". The tool's
`create` action accepts a `url` parameter; the workflow:

1. Fetches the URL content (Slack thread, GitHub issue or
   PR, Graphite PR).
2. Checks whether any existing quest has the URL as an
   alias. If so, proposes loading that quest instead of
   creating.
3. Seeds the new quest's title, aliases, Cast (originator
   resolved through the people registry) and first
   Journey entry (the quoted source content).

Confirm the proposed scaffold before committing.
Adjustments happen through prose; there is no form.

When the URL fetch fails, the tool falls back to seeding
only the URL as an alias and prompts for the title and
Summary.

## When to Scaffold a Document

Plans, research, briefs and reports live as documents
under a quest. Scaffold one when:

- **Plan**: there is implementation work substantial
  enough to think through before doing. The
  planning-guide skill teaches the methodology.
- **Research**: there is an investigation whose findings
  outlive the session, with a question worth recording
  and a verdict worth quoting later.
- **Brief**: you need someone to make a decision or take
  an action. The brief is the artifact you hand them.
- **Report**: the work has landed and you want a record
  of what happened, what landed and what didn't.

A small quest does not need any documents. The README
plus Journey is enough.

## Focus and the Document Loop

At most one document is focused per quest at a time. The
focused document carries its own stage machine (think,
draft, build, conclude, retire). Switching focus does
not change a document's stage. A concluded or retired
document is terminal: thinking from it is refused rather
than silently reopening it, so draft a fresh document or
reopen the quest when work resumes. The kind is a
provisional intent until `draft` mints the id, so a wrong
kind chosen at think is fixable by passing `kind` to
`draft`. A stage transition persists to the document file
before it advances in memory, so a failed write refuses
rather than reporting a stage the file never reached.

Code-write discipline triggers only when the focused
document is a plan in `think` or `draft`. Other document
kinds (research, brief, report) have no implementation
phase and never block code writes.

The gate classifies every write, edit and bash redirect
destination, and treats scratch and devices as first-class
so ad-hoc work is never cornered. Writes to a `/dev` node
(the discard sink, the standard streams) always flow. A
write to bare system temp (`/tmp`, the OS temp dir) is
funnelled into a quest-owned managed scratch directory:
the gate creates it on demand under the OS temp dir,
records it on the quest, and reaps it when the quest
concludes or retires, so all scratch stays controlled and
cleaned up. In `build`, a write inside any tree the quest
tracks flows; a write inside a git tree the quest does not
track is refused with guidance to register it through
`tree-adopt`, so the quest comes to account for every tree
its code lives in. Both `tree-adopt` and `tree-add` accept
a `cwd` parameter, so you adopt or scaffold a tree from any
session without changing your session's directory: point
`cwd` at a path inside the tree to adopt, or at the repo to
scaffold from.

The two origins prune differently. A scaffolded tree is the
tool's to remove: it auto-prunes when the quest concludes or
retires, and a manual `tree-prune` removes it freely. An
adopted (or legacy, unmarked) tree is a shared checkout the
tool did not create, so it is never auto-pruned and a manual
prune refuses unless you pass `force: true` after confirming
with the user. The `tree-list` inventory flags any recorded
tree whose directory has gone missing on disk, so a stale
entry is visible rather than trusted.

## The Resuscitate Pattern

A common motion: a sidequest paused weeks ago, a new Slack
ping brings it back. The steps:

1. `quest find <hint>` and `quest load <id>` to pick up the
   old sidequest.
2. `quest reopen` if it was concluded or retired, to return
   its status to active; then `quest drive` (or `promote`)
   to set its priority.
3. `quest alias-add` for the new context (the Slack thread
   or PR that resurfaced it).
4. Append a Journey bullet noting what brought it back.
5. `quest think kind:plan` if the reactivation needs
   structured work.

Each step is a separate tool call. `reopen` covers the
status flip; the rest read cleanly enough as separate
moves that no further composite verb is planned.

## Conclude vs Retire

- **Conclude**: the work landed. The quest's Outcomes
  section records what shipped. Concluded quests live on
  in the audit trail.
- **Retire**: the work was abandoned. The quest carries a
  reason in its Journey log. Retired quests live on too,
  but rank below active quests when the tool walks the
  tree for a TOC view.

A retired quest can be resuscitated with `quest reopen`. A
concluded quest can also be reopened, though usually a new
quest is cleaner when the work re-opens with a new shape.

Both `conclude` and `retire` accept a `scope` parameter:
`document` acts on the focused document, `quest` acts on
the loaded quest. With no scope, the tool defaults to the
focused document when one is set, otherwise the loaded
quest. Retiring a quest needs a `reason`.

Sealing a quest cascades so it leaves nothing live behind:
the priority drops to `someday` and every still-active
document seals to the quest's terminal stage. You do not
seal documents by hand before concluding the quest that
owns them.

## Echoes

An Echo is an incoming reference: another quest's body
mentions yours by id, or by a URL the refs registry can
resolve back to one of your aliases. The `show` projection
splits Echoes by intent: `Produced by` lists every quest
whose body referred to yours with the → sigil, and
`Referenced by` lists every quest that mentioned you with
a bare id. Skip either section silently when its list is
empty.

## Verbs and Aliases

The `status` action is an alias for `show`; both render
the loaded quest's full projection. `alias-add` refuses a
ref already attached to another quest, naming it, so the
same external reference never points at two quests; load
that quest, or remove the alias there, before re-adding it.
Alias types are matched case-insensitively, so `github-pr`
and `GitHub-PR` are the same type. When you type an
action name that no verb matches, the tool refuses with a
Levenshtein-based suggestion of the nearest canonical
verb (`lst` is told to try `list`; `shw` is told to try
`show`). When no close match exists the refusal points
you at the schema.

## Disambiguation

When `quest find` returns more than one match, ask the
user. Surface the top three (ranked by recency of
`updated`) with the quest's title and a one-line summary.
The user picks by number ("the second one") or by saying
the title. Avoid menus: everything stays prose.

## People Resolution

Cast bullets are parsed for a role and a subject (the
name or handle). The tool runs each subject through the
people-resolver chain (built-in: Slack; downstream
packages add their own resolvers, e.g. Vault). When a
resolver returns an identity, the bullet is tagged with
the identity id so cross-quest "who has Joel as an owner"
queries can answer without fuzzy regex.

Unresolved subjects fall back according to the
fallback setting: `silent` keeps the bare name, `warn`
records it but flags the gap in tool results, `ask`
surfaces it for the agent to query the user. Default is
`warn`.

## Migration from the Old Substrate

If you're working in a project that still uses the old
asks/issues/sidequests substrate under
`~/src/localhost/documents/projects/`, migration is a
collaborative one-shot effort the agent drives with you.
There is no permanent migrate tool. See the plan in
`.pi/plans/PLAN-20260603-yo8-...` for the mapping rules
and the per-project substeps.

---
name: quest-convention
description: >
  Operational conventions for the quest system: when to use
  a quest versus a subquest versus a sidequest, when to
  draft a plan or research document, how to reorder
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
  quest; their parent is that folder itself, which we
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
what happened and why. It lives in the quest's
`JOURNEY.md`, beside the README; read it
only when the history matters, since `show` already gives
the newest entries.

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

Confirm the proposed quest before creating it.
Adjustments happen through prose; there is no form.

When the URL fetch fails, the tool falls back to seeding
only the URL as an alias and prompts for the title and
Summary.

A session with no quest loaded is put on the quest it
creates. A session already on one stays there, since it is
usually filing a follow-up or a subquest for later or for
another session: `load` the new quest to work on it here,
or `spawn` it a session of its own.

## When to Draft a Document

Plans, research, briefs and reports live as documents
under a quest. Draft one when:

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
document is terminal and no stage verb reopens it.
Concluding or retiring the focused document puts it down
(the quest's active plan, if any, is focused in its
place), and thinking or drafting while a finished one is
still focused starts a fresh loop beside it. With nothing
in hand, `draft` given a note and a title thinks and
drafts in one call, and so does `draft` with a new title
while a document in draft or build is focused: that one
is put down where it stands, and `focus` takes it up
again. `think` with a kind likewise starts a fresh loop
beside the focused document; `think` with no kind sends
the focused document back to think. The kind is a
provisional intent until `draft` mints the id, so a wrong
kind chosen at think is fixable by passing `kind` to
`draft`. A stage transition persists to the document file
before it advances in memory, so a failed write refuses
rather than reporting a stage the file never reached.

Code-write discipline triggers only when the focused
document is a plan in `think` or `draft`. Other document
kinds (research, brief, report) have no implementation
phase and never block code writes.

Every quest folder is held to its record, whether or not
the quest is loaded and whatever is focused (quest-format
describes the record). The gate refuses a write it is sure
is wrong and names where it belongs instead:

- a new document written by hand, rather than minted by
  `quest draft`;
- a document or README written by bash, rather than with
  the edit or write tool;
- a document, the README or a kind folder removed, rather
  than the quest retired;
- anything else in a quest folder outside `attachments/`,
  which belongs in the scratch folder;
- an attachment whose name says raw data.

A script, a build or a clone can make files no command
names, so after each call that could touch a quest folder
the gate reads the record from disk and appends what the
call broke to the result. Put it right straight away: move
the file to the destination named. If a run ends with the
record still broken, the agent is asked once to put it
right before finishing. Conclude refuses while anything
remains, and names attachments no document cites.

The gate reads each write, edit and bash destination, and
treats the scratch folder and devices as first-class so ad-hoc
work is never cornered. Writes to a `/dev` node (the
discard sink, the standard streams) always flow. While a
quest is loaded, commands run with `TMPDIR` pointing at its
scratch folder's `tmp/`, which is cleared when the quest
concludes or retires: use `$TMPDIR` or `mktemp`, never a
path you name in `/tmp`, which is refused with that
remedy. A write to any quest's scratch folder flows, so a
note left in another quest's flows too. Write working
material straight into the scratch folder rather than
`tmp/` when it should outlive the session. In `think` or `draft`,
only edits to tracked code in the quest's own trees wait
for `build` (any tree, while the quest tracks none). In `build`, a write inside any tree the quest
tracks flows; a write inside a git tree the quest does not
track is refused with guidance to register it through
`tree-adopt`, so the quest comes to account for every tree
its code lives in. Both `tree-adopt` and `tree-add` accept
a `cwd` parameter, so you adopt or cut a tree from any
session without changing your session's directory: point
`cwd` at a path inside the tree to adopt, or at the repo to
cut from.

Quest cuts the tree; the `work` tool moves the work along
inside it. That boundary is worth stating because both tools
can produce a worktree and only one of them remembers it for
longer than a session. A tree a quest owns is cut with
`tree-add`, recorded in frontmatter and released on conclude, so
it is still findable next week. `work tree` records against the
session instead, which is the right lifetime for an errand and
the wrong one for a quest. Once the tree exists, quest has no
verbs for branching, committing, pushing, rebasing or stacking,
and `work` has all of them: reach for it there rather than for
raw git.

The two origins are released differently. A tree the tool cut is
the tool's to remove: it is released when the quest concludes or
retires, and a manual `tree-release` removes it freely. An
adopted (or legacy, unmarked) tree is a shared checkout the
tool did not create, so it is never released by itself, and a
manual `tree-release` refuses unless you pass `force: true` after
confirming with the person. Once its quest is concluded or retired, an
adopted tree is no longer the quest's to hold: `work tidy`
and `work reclaim` judge it as any tree nothing holds, taking
it only when it is clean and trunk holds its branch. Name the
tree to release or expand with `cwd`, a path inside it: a quest
with several trees refuses rather than guess, and a path that
names none of them is refused too. The `tree-list` inventory
flags any recorded tree whose directory has gone missing on
disk, so a stale entry is visible rather than trusted.

The two origins also magnetize differently. A fresh session,
and an id-less `quest load`, resolve a quest from the cwd only
through the quest's own directory and the trees it cut.
An adopted tree never auto-loads, because a checkout adopted
by several quests cannot say which one you meant; load such a
quest by id instead. For the same reason `tree-adopt` warns
and requires `force: true` before tying a quest to a
repository's main checkout or to a path another quest
already tracks. Adoption stays first-class: it is the
deliberate way to account for a shared checkout, the guard
only stops it happening by accident.

When a session has ended up active on more than one quest
(a legacy store, or a lost reconcile), `session-audit` repairs
it. By default it previews: for each divergent session it
names the one quest the session's own log records as owner and
lists the strays it would detach. It also lists any active
session whose captured identity a probe reads gone, so a
crashed pane's stale membership can be cleaned up. Pass
`force: true` to apply both the divergence detaches and the
dead detaches. Two safeguards hold: a session whose log names
no current claimant is reported conflicted and left untouched
for you to resolve by loading its true quest, and a session
that is dead only by the recency heuristic (no captured
identity to probe) is never detached, because a probe must
have actually observed the process or pane gone before the
verb acts on it.

## Session Liveness and Recovery

A quest tracks the pi sessions that worked on it, and the
tool answers which are alive honestly rather than guessing
from a clock. Liveness is observed when you ask, never
stored: a session resolves to live, idle, dead, unknown or
conflicted from a read-time probe of its recorded process
and terminal, and unknown is a real answer for a session on
another host or one the probe could not reach. A stored
record holds identity, not a verdict.

Three read views serve recovery, and none of them loads or
mutates anything:

- On session start the tool shows a passive hint naming the
  few most recently active sessions, so a fresh shell after
  a crash can see where work was. The hint reads only cheap
  log activity; it never probes liveness and never loads a
  quest.
- `quest recent` is the authoritative picker: one row per
  prior session across every quest, resolved to its quest,
  cwd, activity age and probed liveness. It keeps dead and
  detached sessions so a crashed pane is recoverable, and a
  session claimed by several quests collapses to the one its
  own log names as owner. Each row prints its
  `pi --session <id>` resume command.
- `quest sessions` is the live view: one row per session,
  never collapsed per quest, so two live panes read as two
  rows and a crash shows beside its live sibling.
- `quest restore` brings back the tabs something took away.
  A session records itself when it loads a quest, and a
  crash, a closed tab, the terminal dying or quitting, or a
  shutdown all leave that record marked lost; a deliberate
  `/quit` does not. Restore lists the lost sessions with a
  `pi --session` recipe each (a fresh pi on its quest for one
  lost before pi saved it), then the sessions closed on
  purpose in the last day as a backstop. It lists only;
  `force` reopens the lost ones, and `id` (session ids or
  unique prefixes, comma-separated) narrows it to named
  sessions from either list, which `force` then reopens.
  Confirm with the person before `force`, since it opens a
  terminal per session. The listing says which terminal and
  layout `force` would use; pass `layout` (window, tab or
  pane), `terminal` or `nesting` to change it for this call,
  and leave them out to follow the person's settings.
- `spawn` opens a terminal for a quest in the person's
  default layout; `spawn-tab`, `spawn-pane` and
  `spawn-window` name theirs. Pass `dryRun` to see where it
  would open first.

To resume a prior session, run `quest recent` and copy the
resume command for the row you want, rather than reaching
for a raw session id. A loaded quest also names its pi tab
with its stable short id, so a person scanning their
terminal's tabs can tell them apart without a query.

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

A quest is only ever sealed by name: pass its `id`. With
no id, `conclude` and `retire` act on the focused
document, and with nothing focused they refuse and say
which id to pass. Naming the loaded quest seals it in
full, releasing its trees and clearing its scratch folder's
tmp/; naming quests that are not loaded runs the
reversible status sweep. Retiring a quest needs a
`reason`.

## Unload vs Conclude

- **Unload** puts a quest down: this session stops
  working on it and nothing on disk changes. Use it to
  switch away, to pause, or when asked to close a quest
  without being told it is done.
- **Conclude** seals a quest for good: its status,
  priority, documents and trees all change. Use it only
  when the work has landed and you were told to, or the
  plan says so, and name the quest's id.

When it is not clear which was meant, unload: it can be
undone by loading again, and a seal cannot be undone by
anything as simple.

## Editing a Quest's Documents

The workflow rewrites a README or plan on its own, between
the moment a hand edit reads it and the moment it writes,
so routine edits go through verbs that hold the quest lock:

- `journal` with `note` adds a dated Journey entry.
- `tick` and `untick` with `query` set a checkbox item,
  named by its text or a start only it has.
- `section` with `title` and `body` replaces one `##`
  section. A plan, research, brief or report that has no
  such section gets it added at its end. A README's
  sections are a closed set: one of its four optional
  sections (Milestones, Spirit, Outcomes, Context) is
  added in its place, with its emoji, and any other
  heading it lacks is refused. Journey is never replaced,
  only added to.

They act on the focused document, or the README when
nothing is focused. `id` names any document or any quest
(for its README), loaded or not, so a note for another
quest never needs a `load`; `journal` given a document's id
writes to that document's quest. `conclude` and `retire`
take any document's id the same way, and a document of
another quest is finished where it lies, with the Journey
entry in its own quest. Larger rewrites still use edit and
write, but never change the fields the workflow owns: a
document's `stage`, `id`, `kind` and `quest`, and a
quest's `id`, `kind` and `status`. The gate refuses that
and names the verb that does it.

Read a document through `show` too: its `id` alone gives
the outline (each section with its size, the open items,
the next), `title` one section, and `query` one item with
its notes. A plan grows past 400 KB, and whatever a read
brings in is paid for on every turn after it, so a shell
`grep` or `sed` of a document, or a `read` of a whole one,
is refused with the `show` call that answers it. Asked
again, it goes through, for the rare time the raw file is
what you need.

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
person. Surface the top three (ranked by recency of
`updated`) with the quest's title and a one-line summary.
The person picks by number ("the second one") or by saying
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
surfaces it for the agent to ask the person. Default is
`warn`.

## Migration from the Old Substrate

If you're working in a project that still uses the old
asks/issues/sidequests substrate under
`~/src/localhost/documents/projects/`, migration is a
collaborative one-shot effort the agent drives with you.
There is no permanent migrate tool. See the plan in
`.pi/plans/PLAN-20260603-yo8-...` for the mapping rules
and the per-project substeps.

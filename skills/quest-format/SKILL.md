---
name: quest-format
description: >
  Structure of a quest README and the documents that live
  under it: frontmatter shape, the four core and four
  optional body sections, emoji glyphs, ID format,
  alias notation, Cast bullets and Journey entries. Use
  when writing or editing a quest README, a plan, research,
  brief or report document under a quest. Pairs with
  quest-convention for choices like kind, promotion and
  reordering. Follow the prose-standard for voice.
---

# Quest Format

A quest README is the canonical document for one quest. A
small frontmatter block carries machine-readable scalars;
the body is markdown the author owns, with four mandatory
sections, four optional, and one freeform Journey log that
narrates progress over time.

## Identifiers

Every quest and document carries a stable id of the form
`PREFIX-YYYYMMDD-XXXXXX`:

- `PREFIX`: four-character code for the kind.
  - `QEST` for any quest (top-level, sub or sidequest).
  - `PLAN` for plans, `RSCH` for research, `BRIF` for
    briefs, `RPRT` for reports.
- `YYYYMMDD`: creation date in the local timezone.
- `XXXXXX`: six base-36 (upper) random characters.

The directory holding a quest is named exactly `{id}`. No
slug, no friendly suffix. The H1 of the README carries the
human-readable title.

## File Layout

All quests live as immediate children of `questsRoot`.
Hierarchy is expressed through the `parent:` front-matter
field, never by directory nesting. Documents (plans,
research, briefs, reports) live inside their owning
quest's kind subdirectory.

```
questsRoot/
  QEST-20260603-AAA111/
    README.md
    plans/
      PLAN-20260603-BBB222.md
    research/
      RSCH-20260604-CCC333.md
  QEST-20260605-DDD444/          (subquest of AAA111,
    README.md                      flat at the root,
                                   parent: QEST-...-AAA111
                                   set in its front-matter)
```

Discovery refuses these two drift patterns as layout
errors and skips the offending entry:

- a `QEST-*` directory found inside another quest
- a `PLAN-/RSCH-/BRIF-/RPRT-*.md` file at a quest's root
  instead of inside `plans/`, `research/`, `briefs/`
  or `reports/`

Free-form subdirectories (`runs/`, `tools/`, `evidence/`)
are fine; the discovery walk ignores them.

## Frontmatter

A small YAML block at the top of every quest README:

```yaml
---
id: QEST-20260603-AAA111
kind: sidequest
parent: null
status: active
priority: driving
rank: 1
started: 2026-06-03
updated: 2026-06-03
due: 2026-08-01
eta: 2026-07-15
aliases:
  - type: github-issue
    value: shop/world#47281
  - type: slack-thread
    value: shopify/CXXXX/p1778683833000200
sessions:
  - id: 019e7a4b-516e-7911-a1ff-6d5383f7fa64
    name: investigation
    cwd: /Users/joel/world
    started: 2026-06-03T18:14:00Z
    status: active
    instanceId: 2b1f9c7a-0e44-4a1b-9c3e-8d5f6a2b1c00
    process:
      hostId: studio.local
      pid: 48213
      startToken: Tue Jun  3 18:14:00 2026
    terminal:
      driverId: wezterm
      value: "7"
      scope: /run/user/1000/wezterm/gui-sock-1
  - id: 71c4f0c8-2b9a-49e3-bb87-2a3a96c12f4d
    status: detached
---
```

Field semantics:

- `kind`: `quest`, `subquest` or `sidequest`. See
  quest-convention for choosing.
- `parent`: the id of the parent quest when this is a
  subquest, or `null` for top-level quests and
  sidequests.
- `status`: `active`, `paused`, `blocked`, `concluded`
  or `retired`.
- `priority`: `driving`, `active`, `queued`, `bench` or
  `someday`.
- `rank`: integer ordering within the sibling set
  (within the same priority and parent). Lower wins.
- `started`/`updated`: YYYY-MM-DD.
- `due`/`eta`: optional dates.
- `aliases`: list of objects with `type` and `value`,
  recognised by the refs library. Common types are
  `github-issue`, `github-pr`, `github-repo`,
  `slack-message`, `slack-thread`. For backward read
  compatibility, bare `type:value` strings are also
  accepted on parse and normalised on write.
- `sessions`: list of pi sessions that have driven this
  quest. Each entry has an `id` plus optional `name`,
  `cwd`, `started` (ISO timestamp) and `status`
  (`active` or `detached`). The workflow maintains the
  list as sessions attach. A bare string is read as an
  id-only session for compatibility with older files.
  Only persisted sessions are recorded: an ephemeral
  `pi --no-session` run (a subagent or council fan-out)
  is never attached, so it cannot leave a log-less
  phantom. An attached session may also carry a captured
  identity so its liveness can be probed rather than
  guessed: `instanceId` (minted once per pi process),
  `process` (`hostId`, `pid`, `startToken`, guarding pid
  reuse and remote hosts), and `terminal` (`driverId`,
  `value`, optional `scope`, a probeable handle to the
  pane). All three are optional; a legacy record without
  them still reads by activity recency. Loading a quest detaches the session from the
  quest it is leaving, and reconciles membership by
  detaching the session from any other quest that still
  lists it active, so one session reads `active` on at
  most the quest it is on even after a lost state or an
  earlier run left a straggler; it also prunes any
  detached entry whose session log no longer exists. Liveness
  is observed when read, never stored: `show`, `workspace` and
  `recent` derive each session's state from a read-time probe
  of its recorded process and terminal, one of `live`, `idle`,
  `dead`, `detached`, `conflicted` or `unknown` (a session on
  another host or one the probe could not reach reads
  `unknown`, never a false `dead`). They also show a relative
  last-active age and mark the session a reopen would resume.

- `verify`: optional shell command the verification
  workflow runs to check work on this quest, in
  preference to a project script. Use it to scope the
  check to the subdirectory or zone the quest touches,
  e.g. `verify: pnpm test lib/lsp`.

Documents under a quest carry their own smaller
frontmatter:

```yaml
---
id: PLAN-20260603-BBB222
kind: plan
quest: QEST-20260603-AAA111
stage: draft
updated: 2026-06-03
---
```

## Body Sections

Every quest README has four mandatory sections, in this
order, with their canonical emoji glyphs:

- `## 📜 Summary` — one paragraph: what this quest is and
  why it exists.
- `## 🧭 Purpose` — why now, what good looks like, scope.
- `## 🎭 Cast` — the people involved, as role-prefix
  bullets (see below).
- `## 🌄 Journey` — dated bullets logging progress over
  time. Newest at the top.

Four optional sections, added when there's something to
say:

- `## 🎯 Milestones` — GitHub task-list bullets that drive
  the status bar's progress glyph.
- `## 🔥 Spirit` — the stable north star that survives
  deviation.
- `## 🏆 Outcomes` — what landed when this quest
  concluded.
- `## 🏰 Context` — background that doesn't fit elsewhere.

## Cast Bullets

Cast bullets use a role-prefix convention. Each bullet
starts with a bolded role keyword and a colon, the
person's name or handle, and optional prose:

```markdown
## 🎭 Cast

- **owner**: Joel Gerber. Coordinates the investigation.
- **reviewer**: @xiao.li. Gates the auth changes.
- **originator**: @chao.duan. [Slack 2026-05-06](url).
- **collaborator**: Natalia Maximo. Owns the auth side.
- **stakeholder**: Mark Dorison.
```

The role vocabulary is open; the recommended starter set:
`owner`, `reviewer`, `originator`, `collaborator`,
`stakeholder`, `reporter`, `handed-off-to`,
`handed-off-from`, `consulted`. New roles work for free;
the tool indexes whatever keyword it sees.

The structured prefix is what lets `quest who Joel` answer
cross-quest questions like "Joel owns three driving
quests" without fuzzy regex on prose.

## Journey Entries

Journey bullets are dated and chronological, newest first:

```markdown
## 🌄 Journey

- **2026-06-04**: Reproduced the 401 locally with a stale
  auth token. Filed shop/world#47282 with the trace.
- **2026-06-03**: Created the sidequest from Ahmad's
  report.
```

Each entry is a bullet. The date is a bold-wrapped
`YYYY-MM-DD`. Prose follows after the colon and can wrap
onto subsequent lines (indented).

The Journey is the rich narrative log; the `status` field
is a coarse enum. The tool synthesises status prose on
demand from frontmatter plus recent Journey entries.

## Inline Links and References

Anywhere in the body, you can:

- Link freely with `[text](url)`. The tool indexes any
  URL the refs library recognises.
- Reference other quests by bare id: `QEST-20260601-XXX`.
- Reference documents by their id: `PLAN-20260603-YYY`.

There is no typed-link taxonomy. The relationship is in
the prose; the tool surfaces inbound references on `quest
show` as Echoes.

One lightweight sigil is recognised: an id preceded by
`→` reads as "this quest produced that one," and `quest
show` lists it under `Produced by:` rather than
`Referenced by:`. The natural prose is
`- [ ] Synthesize findings → BRIF-20260605-CCC333`. A
bare id stays a reference; no schema change is needed.

## Document Templates

Each document kind has a starting set of sections that
the scaffolding writes. The author overwrites the guidance
text immediately.

- **plan**: Spirit, Context, Approach, Work, Open
  Questions, Discovery & Deviations. See the
  planning-guide skill for the full methodology.
- **research**: Question, Method, Findings, Verdict.
- **brief**: Audience, Ask, Background, Recommendation.
- **report**: What Happened, Outcomes, Lessons.

Section names are guidance, not contract. Only the
frontmatter (id, kind, quest, stage, updated) and the
GitHub task-list checkboxes are parsed.

## Voice

Quest content is human prose. Follow the prose-standard
skill for voice, spelling and punctuation rules across
every section.

---
name: browser-guide
description: >
  Drive a real browser with the browser_go, browser_see,
  browser_do and browser_check tools: navigate, read the page
  as an accessibility outline, query the DOM across frames and
  shadow roots, inspect one element's box and cascade, run
  expressions, press keys and gestures, wait for conditions,
  read console and network telemetry, emulate devices, shape
  the network, take screenshots, and form verdicts about
  accessibility, layout, design drift, visual diffs and
  performance. Use when asked to "open a page", "look at this
  site", "click the button", "what does the page say", "why is
  this element red", "check the console", "what requests did
  it make", "test it on mobile", "is this accessible", "did
  the layout break", "what changed visually", or any request
  that involves looking at or operating a web page.
---

# Driving a Browser

Four tools share one set of named, persistent sessions.

| Tool | For |
|---|---|
| `browser_go` | Where the session is, and the conditions it runs under |
| `browser_see` | Reading. Never changes the page |
| `browser_do` | Changing the page |
| `browser_check` | Forming a verdict |

The split is by intent, not by subject. Screenshots are `see`
because looking at a page does not change it. Emulating a phone
is `go` because it changes the conditions rather than the page.

## Start Here

`browser_go` with a `url` opens a session and navigates in one
step. There is no separate setup call.

```
browser_go url:"https://example.com"
browser_see                      # the page as an outline
```

`kind` is optional wherever the arguments already say what you
mean. `browser_go url:...` is a navigate. `browser_see` with no
arguments is the page. Only reach for `kind` when the arguments
alone are ambiguous.

Sessions are named and persist across calls. Pass `session` only
when you want more than one open at once; otherwise everything
lands in `default`.

## Address Elements by Role and Name

The page is read as an accessibility outline, and elements are
named the way that outline names them: a role plus the
accessible name.

```
browser_do role:"button" name:"Save changes" action:"click"
browser_see kind:"element" within:"navigation Main"
```

Not CSS selectors. This is deliberate: it is the same way a
screen reader user addresses the page, so a target that cannot
be named this way is usually a real accessibility problem rather
than an inconvenience.

When a target does not resolve, the refusal lists candidates
that do. Read them rather than guessing again: they come from
the live page.

`browser_do act` waits for the element to become actionable
before operating it. Do not add a wait before a click out of
habit.

## The Loop

Observe, act, observe. Every `browser_do` returns a short health
trailer so you can see what the action did without asking again.

When something does not work, the order that finds it fastest:

1. `browser_see` to confirm the page is what you think it is
2. `browser_see kind:"logs"` for what the page complained about
3. `browser_see kind:"requests"` for what it asked the network
4. `browser_see kind:"element" within:"..."` for one element in
   depth, with `why:"<property>"` to trace a style through the
   cascade

## Reading Without Drowning

Every list is paged and every large artifact goes to disk. This
is not a cap on what you can ask for: it is a default about how
the answer arrives.

- Lists take `limit` and report the true total regardless of how
  many are shown. If the total surprises you, that is the finding
- Screenshots never come back inline. They are written to the
  session bundle and the answer carries the path. `see status`
  lists everything written
- `see query` with no query returns the shape of the page rather
  than every node. Narrow with `tag`, `attribute`, `className`,
  `text`, `rendered` or `inShadow`

Prefer the narrowest reading that answers the question. `see
element` on one element beats `see query` over the page; `see
query` beats `do eval` returning a large structure.

## What Each Verb Covers

### `browser_go`

`navigate`, `open`, `close`, `reload`, `back`, `forward`.

- `emulate`: a device, viewport, media preference, vision
  deficiency, locale or timezone. Reports where the browser
  diverged from what you asked, which matters: setting a
  device viewport does nothing to a page with no viewport meta
  tag, and locale overrides never reach `navigator.language`
- `network`: `mock` a response, `block` a pattern, `throttle` to
  a named profile, or `clear` everything. Interception only
  attaches while a rule exists
- `storage`: read, write or clear cookies, local and session
  storage, and the clipboard
- `dialogs`: decide how alerts and confirms are answered. The
  default is dismiss, and every dialog seen is recorded

### `browser_see`

`page`, `reading`, `announcements`, `element`, `query`, `logs`,
`requests`, `downloads`, `shot`, `vitals`, `status`.

- `element` takes `why:"<property>"` to trace one CSS property
  through every rule that had a say, with authored source
  positions when a source map exists
- `requests` takes `body` to fetch one response body on demand,
  and `har` to export the whole conversation
- `status` is the one to reach for when behaviour makes no
  sense: it reports what the session is pretending to be, what
  it is intercepting, how it answers dialogs, and whether the
  page has crashed

### `browser_do`

- `act`: click, type, hover, focus, select, at a named element
- `press`: key chords such as `Control+Shift+K`
- `input`: raw pointer and touch, including drag, swipe and
  pinch, for what semantics cannot reach
- `wait`: for a selector, text, network quiet, a request
  pattern, animations settling, or a duration
- `eval`: run an expression. DOM nodes, functions and circular
  structures are described rather than serialized, and an
  exception comes back as a result with its stack mapped to
  authored source

### `browser_check`

Covered in full by the `browser-accessibility-guide` for the
accessibility kinds. In brief: `keyboard`, `accessibility`,
`visual`, `design`, `compare`, `perf`, `health`.

Start with `health` when the question is "did I break
anything". It runs everything and reports one digest, then name
a kind to see that one in full.

Any check but `keyboard` takes `widths` and answers with a table
across them. Most layout faults are conditional, so a check at
one width can pass a page that is unusable on a phone.

## Reading a Verdict

Every check opens with `PASS`, `WARN` or `FAIL`, a headline, and
what was measured.

**`WARN` never means "probably fine".** It means something could
not be decided, and the two are opposite. Text over a gradient,
a page with no focusable controls, a comparison with no baseline
yet: all warn, because reporting them as passes would be a lie
of the most damaging kind. If you relay a `WARN` to the user as
a pass, you have introduced the exact failure the tool went out
of its way to avoid.

**Read what was measured before trusting a `PASS`.** "Nothing
failed" and "nothing failed across 41 elements and the axe rule
set" are the same verdict and very different reassurances. The
first is also what a check that silently did nothing says.

## Present Findings, Do Not Parrot

The reports are written to be read by a person. Summarise what
matters and say what you would do about it; do not paste a
verdict block back with no interpretation, and do not restate a
table that the user can already see.

When a check fails, lead with the thing worth fixing first,
which the report has already put at the top.

## Common Mistakes

**Using a CSS selector where a role and name belong.** `see
query` takes tags and attributes because it is a search. `do
act` and `see element` take role and name because they operate
on a specific thing.

**Adding a wait before a click.** `do act` already waits for
actionability. Use `do wait` for a state the page reaches on its
own, not for an element you are about to operate.

**Asking for a screenshot to find something out.** An image
costs far more context than the reading that would have answered
the question. Reach for `see page`, `see element` or `see query`
first, and take a screenshot when a human needs to look at it.

**Treating design drift as a defect.** `check design` reports
values close enough to have been meant as one. Two blues a step
apart may be a bug or may be a hover state. The tool says which
values cluster; deciding is a person's job, so present it as a
question.

**Reporting a first baseline as a clean comparison.** The first
`check compare` records a baseline and warns. Nothing was
compared. Say so.

**Believing an emulation took effect because it was accepted.**
`go emulate` reports divergence between what you asked for and
what the browser actually did. Read that part.

## Sessions and Cleanup

Sessions persist until closed or the pi session ends. Close one
when a task is done and another is starting against a different
site, so state, storage and emulation do not leak between them.

Artifacts (screenshots, HAR archives, downloads, baselines) stay
on disk and are listed by `see status`. Baselines deliberately
survive between sessions, since a baseline that vanished would
compare against nothing every time.

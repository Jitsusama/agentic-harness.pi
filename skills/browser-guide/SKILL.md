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

If you named a session when you navigated and then leave `session`
off a later call, the only open session is used and the answer
says which. With several open, the call is refused and the names
are listed, because reading a verdict without knowing which page
it judged is how the wrong page gets fixed. A name you pass is
never second-guessed, so a typo is reported rather than quietly
redirected.

## Four Jobs, Four Entry Points

Most questions about a page belong to one of four jobs, and
entering by the right door saves the round trips.

**Judging design and layout.** `browser_check kind:"design"`
inventories the colours, type, spacing and shadows the page
actually uses, and flags values close enough to have been meant
as one. `browser_check kind:"visual"` reports what the layout
did wrong. `browser_see kind:"shot"` photographs it, and
`browser_go kind:"emulate"` puts the page on a phone, in dark
mode or under a colour-vision condition first, so the shot shows
what that visitor sees. `browser_check kind:"compare"` holds a
baseline still and says which regions changed.

**Reviewing accessibility.** Read the browser-accessibility-guide
skill before reporting anything; it owns the order of work: the
keyboard walk first, then the rule sets, then the reading order
and announcements, then contrast under the conditions that break
it.

**Engineering a fix.** `browser_see kind:"element"` reports one
element's box, visibility, listeners and animations, and `why`
traces one CSS property through every rule that had a say, which
answers "why is this red" from the cascade rather than from
guesswork. `browser_see kind:"logs"` and `kind:"requests"` are
what the page said and what it asked the network for.
`browser_see kind:"query"` finds nodes across frames and shadow
roots, including the ones the browser did not draw, which is how
you learn why something is missing. `browser_do kind:"eval"`
interrogates the page directly.

**Validating behaviour.** `browser_do` acts, presses and waits;
read the page again after each act rather than assuming the
action worked. `browser_go kind:"network"` mocks, blocks,
throttles or goes offline, so failure paths can be exercised
without breaking anything real. `browser_go kind:"emulate"`
changes the visitor. `browser_check kind:"health"` runs every
verdict at once, and `widths` on any check repeats it at several
viewports, because most layout and contrast faults are
conditional on width.

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

After anything changes the page, the answer waits for the page to
stop changing before describing it, so the outline you get is
where the page ended up rather than where it was. A page that is
still moving when the budget runs out is described anyway, with a
line saying so: read that line rather than treating the outline as
final.

One case it cannot cover. A control that debounces, most often a
search box, does nothing at all for a moment after you type, and
nothing distinguishes "about to search in 200ms" from "finished".
When you need the result of a debounced interaction, wait for the
thing you expect rather than trusting the settle:

```
browser_do action:"type" role:"combobox" name:"Search" text:".."
browser_do for:"text" text:"results"
```

## The Loop

Observe, act, observe. The three `browser_do` kinds that change
the page answer with a fresh page view, so you see the result of
what you just did without asking again.

When something does not work, the order that finds it fastest:

1. `browser_see` to confirm the page is what you think it is
2. `browser_see kind:"logs"` for what the page complained about
3. `browser_see kind:"requests"` for what it asked the network
4. `browser_see kind:"element" within:"..."` for one element in
   depth, with `why:"<property>"` to trace a style through the
   cascade

## Components and Frames Are Not Walls

Everything that reads or judges the page descends through open
shadow roots and same-origin frames. A design-system page built
from custom elements is not a row of empty tags: its buttons are
found, checked, walked and clicked like any others.

A selector that crosses a boundary is written with `>>`, the way
devtools and Playwright write it, so a finding against
`my-card >> button` names something you can go and look at.

Two limits are real and are reported rather than hidden. A closed
shadow root is unreachable by anybody, us included. A cross-origin
frame runs in another process and its document cannot be read from
page script, so those are counted and named, never quietly
skipped. If a page seems to be missing content you can see, `see
query` with `inShadow` and the unreachable count in the answer are
where to look first.

## What Counts as Being on the Page

The checks judge what a person is actually offered, which is not
the same as what exists in the DOM.

A control inside a closed dialog, or hidden by `visibility`, or in
an `inert` subtree, is not a keyboard stop, not a pointer target
and not part of the design. A screen-reader-only label clipped to
a pixel is not something anybody looks at. None of those are
reported as faults, because none of them are.

One case deliberately still counts: `opacity: 0`. Such a control
is still focusable and still clickable, so it is judged, and focus
landing somewhere invisible is reported as the defect it is.

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

### When an Answer Cites a Handle

An answer that holds more than it shows ends with a handle and
the shape of what is behind it. The handle is the rest of that
answer, already captured. Query it rather than running the tool
again with different arguments: a second run is a second page
load against a page that may have moved on, and it costs what
the first one cost.

Two cases are easy to miss.

- A citation does not only mean the answer was too long. An
  audit prints a few example elements per rule and stores every
  one it found, so `check accessibility` on a page with eight
  thousand matching elements shows five and cites the rest. The
  answer is short and still incomplete
- `see announcements` and `see requests` end with a cursor or a
  path that survives the cut. Read those from the bottom of the
  answer, not from the middle of the list

Raising `budget` is not how you see more. Whatever is cut is
stored either way, so a larger budget spends a context window
reaching data that a query already reaches, and it is clamped in
any case. Narrow with `only`, `depth`, `within` or `filter`, or
follow the handle.

## What Each Verb Covers

### `browser_go`

`navigate`, `open`, `close`, `reload`, `back`, `forward`. All six
answer with the page they landed on, so you do not need a `see`
call to confirm where you are. Going back past the first
navigation lands on the blank page the session opened with, and
says so.

A navigation that never arrives is reported, not thrown: being
offline on purpose is a normal thing to be. The attempt is in the
request log under `filter: failed`.

- `emulate`: a device, viewport, media preference, vision
  deficiency, locale or timezone. Reports where the browser
  diverged from what you asked, which matters: setting a
  device viewport does nothing to a page with no viewport meta
  tag, and locale overrides never reach `navigator.language`.
  Emulating before navigating is fine and is the usual order; a
  blank page cannot be measured, so it says that rather than
  inventing divergences. Pass `device: none` to stop pretending,
  which clears the viewport, touch and user agent together
- `network`: `mock` a response, `block` a pattern, `throttle` to
  a named profile, or `clear` everything. Interception only
  attaches while a rule exists. An unknown profile name is
  refused rather than quietly ignored, because a test that
  believes it is offline and is not will report the wrong thing
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
  page has crashed. What it is pretending is checked against the
  page rather than recited, so a `not landed` line means an
  override did not survive the last navigation

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
one width can pass a page that is unusable on a phone. Keyboard
reach is conditional too: a sidebar that only exists above a
thousand pixels can be unreachable there and invisible below, so
sweep `health` before believing a single-width pass.

A check needs a page. On a session that has not navigated, or one
that has stepped back past its first navigation, the call is
refused rather than answered: a blank page has no lang, no
landmark and no heading, so judging it would report four failures
about nothing.

## Reading a Verdict

Every check opens with `PASS`, `WARN` or `FAIL`, a headline, and
what was measured.

**`WARN` never means "probably fine".** It means the tool will
not decide this one for you, which is the opposite. There are two
ways that happens, and the headline always says which.

Nothing could measure it: text over a gradient, a page with no
focusable controls, a comparison with no baseline yet. Reporting
any of those as a pass would be a lie of the most damaging kind.
If you relay a `WARN` to the user as a pass, you have introduced
the exact failure the tool went out of its way to avoid.

Or nothing was broken but something is still worth your
judgment. A best-practice rule failing is the common case: two
level-one headings on a page is somebody's good advice, not a
standard. Say what it is rather than inflating it.

**`FAIL` means a standard was violated**, and nothing else earns
it. That is what makes it safe to gate a build on. A check that
spent `FAIL` on advice would have to be ignored, and then it
would be ignored the once it mattered.

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

A session lives until you close it, the pi session ends, or it
goes half an hour without being used. Idle means no activity, so
a long check is never closed underneath itself. Close one when a
task is done and another is starting against a different site, so
state, storage and emulation do not leak between them.

If a session does lapse, the refusal says so rather than claiming
the name was never used. That distinction matters: it means your
navigation, storage and emulation are gone and need setting up
again, not that you mistyped.

A tab can also crash, which is not the same as lapsing. The
session replaces the tab and keeps its name, its cookies and
everything it has recorded, so the logs, requests and downloads
from before the crash are still there and the next call lands on
the replacement. What is gone is the page: whatever it held in
memory, and wherever it had got to. `see status` shows `crashed`
followed by `recovered` in its history, which is the only place
that says why the page you were on is now blank.

Artifacts (screenshots, HAR archives, downloads, baselines) stay
on disk and are listed by `see status`. Baselines deliberately
survive between sessions, since a baseline that vanished would
compare against nothing every time.

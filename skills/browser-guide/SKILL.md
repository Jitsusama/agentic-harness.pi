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

## If You Are Looking for Something Specific

Four reviewers were once asked what these tools could not do, and
two of the eight things they reported as missing were already
there. Both were findable only if you already knew the word to
look for. So before concluding something is not supported, check
here.

| You want to | Ask for |
|---|---|
| Photograph one component, not the whole page | `see kind:"shot" within:"button Save"` |
| See how a page prints | `go kind:"emulate" media:"print"`, then read or shoot |
| Attach a file to a form | `do action:"upload" role:"button" name:"..." files:[...]` |
| Know why a click did nothing | `see kind:"element" behaviour:true`, which reports handlers on ancestors too |
| Know why an element is the colour it is | `see kind:"element" why:"color"` |
| See a focus ring or a hover style | `see kind:"element" states:["focus-visible","hover"]` |
| Where did focus end up after that click or key | `see kind:"focus"`, which reads without moving it |
| Read one CSS property across the whole page | `see kind:"query" styles:["z-index"]`, which reports it for every match |
| Is this icon or border visible enough against that surface | `check kind:"contrast" within:"button Save" and:"region Card"` |
| Judge text axe handed back as needing a person | `check kind:"contrast" within:"heading ..."` |
| Check a phone layout | `check widths:[375,768,1280]`, which works with every kind |
| Wait for a spinner to finish, not for a guessed delay | `do kind:"wait" selector:"#save" attribute:"aria-busy" value:"false"` |
| Wait until a list has loaded all its rows | `do kind:"wait" selector:"li.row" count:20` |
| Assert the save actually succeeded, not just returned | `do kind:"wait" pattern:"*/api/save" status:200` |
| Did that font load, or did it fall back | `see kind:"element"` lists the fonts actually painted |
| Read a counter, a status message or a filled field | `see kind:"element"` reports text, value and data attributes |
| Something takes 3 seconds and I do not know what | `see kind:"profile" ms:3000` while the slow thing runs |
| Why did this click take so long, and what did it set off | `do kind:"act" ... trace:"async"` |
| Which fetch was waiting on which, and what answered first | `do ... trace:"async"` reports overlap and out-of-order settling |
| Did my timer fire when it promised | `do ... trace:"async"` pairs each install with its fire |
| Scrolling or animation stutters | `do kind:"wait" for:"duration" ms:2000 trace:"frames"` while it stutters |
| The tab gets slower the longer it is open | `see kind:"heap"`, do the thing, `see kind:"heap"` again |
| Scrolling or animating this page stutters | `see kind:"layers"` for what the compositor is holding |
| Does anything here only respond to a mouse | `see kind:"hover"` for hover treatments with no focus match |
| What does this page do on hover | `see kind:"hover"` |
| Why is this element on its own layer | `see kind:"layers"` and read the reason beside it |
| A live feature updates by itself and I cannot see why | `see kind:"sockets"` for the websocket conversation |
| Is that gap 16px or 12px | `see kind:"measure" within:"button Save" and:"button Cancel"` |
| A click opened a new tab, or seemed to do nothing | `go kind:"tabs"` to list, then `tab: N` to switch |
| Test a page behind a login without signing in each time | `go kind:"storage" save:"/tmp/signed-in.json"` once, then `load:` it |
| Test with the network off or slow | `go kind:"network" throttle:"offline"` |
| Answer a request yourself | `go kind:"network" mock:"*/api/*" body:...` |
| See the page as a colour-blind or low-vision visitor | `go kind:"emulate" vision:"deuteranopia"` |
| Read what a screen reader would say | `see kind:"reading"` |
| Know what the page announced | `see kind:"announcements"` |
| Find a node the outline does not show | `see kind:"query"`, which crosses frames and shadow roots |
| See what changed since last time | `check kind:"compare"` |
| Get the whole of an answer that was bounded | `result_query` with the cited handle |

If what you want is not here and not in the verb summaries below,
say so plainly rather than building a workaround out of
screenshots. A missing capability is worth reporting; a
hand-rolled substitute for one that exists is not.

## Every Kind, In One Place

The table above is the shortest route for a handful of common
intents. This is the whole surface, so nothing has to be guessed
at or rebuilt. A gate keeps it complete: a kind that ships without
appearing here fails the suite.

**`browser_go`**, which puts a session somewhere and sets its
conditions: `kind:"open"`, `kind:"navigate"`, `kind:"close"`,
`kind:"reload"`, `kind:"back"`, `kind:"forward"`,
`kind:"dialogs"`, `kind:"emulate"`, `kind:"storage"`,
`kind:"network"`, `kind:"tabs"`.

**`browser_see`**, which reads and changes nothing:
`kind:"page"`, `kind:"reading"`, `kind:"announcements"`,
`kind:"logs"`, `kind:"requests"`, `kind:"status"`,
`kind:"downloads"`, `kind:"query"`, `kind:"vitals"`,
`kind:"element"`, `kind:"measure"`, `kind:"sockets"`,
`kind:"heap"`, `kind:"profile"`, `kind:"layers"`,
`kind:"hover"`, `kind:"focus"`, `kind:"shot"`.

**`browser_do`**, which changes the page: `kind:"act"`,
`kind:"press"`, `kind:"input"`, `kind:"wait"`, `kind:"eval"`.

**`browser_check`**, which forms a verdict: `kind:"keyboard"`,
`kind:"accessibility"`, `kind:"visual"`, `kind:"design"`,
`kind:"contrast"`, `kind:"compare"`, `kind:"perf"`,
`kind:"health"`.

Two answers live in stored results rather than in a kind of their
own, and both were rebuilt by hand once for want of being written
down. `check kind:"keyboard"` stores `stops`, the order focus
actually visited, and `missed`, the controls it never reached:
query the cited handle instead of enumerating focusables yourself.
`see kind:"query"` with `styles` reports named properties for
every match, which is the page-wide computed-style sweep.

**Two surfaces measure position from different origins, and each
says which.** `see kind:"query"` reports a box measured down the
document, ending "on the page". `see kind:"element"` reports the box
model, measured from the viewport, ending "in the viewport". On a
scrolled page the same element reads differently in each, differing
by exactly how far the page has moved. Do not compare one against
the other, and do not conclude a layout is broken because two
numbers for one element disagree: read the suffix. Use the page
figure to say where something sits in the document, and the viewport
figure to reason about what is on screen.

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
guesswork. With `behaviour`, the listeners include the ones bound
further up that events from this element still reach, so a
control bound by delegation does not read as a dead one.
`browser_see kind:"logs"` and `kind:"requests"` are what the page
said and what it asked the network for.
`browser_see kind:"query"` finds nodes across frames and shadow
roots, including the ones the browser did not draw, which is how
you learn why something is missing. Give it `styles` to report
named CSS properties for every match, which is the way to sweep a
whole page for a computed value: colours across every heading,
`z-index` on everything that stacks, `overflow` wherever text
might clip. Each match already carries its box, so target sizes
and overlaps are there without asking. A property the browser
did not answer is named as not reported rather than dropped, so
silence and a value never look alike. `browser_do kind:"eval"`
interrogates the page directly.

Reach for `eval` last. A session that spends most of its
`browser_do` calls on `eval` is reporting a gap in these tools:
the expressions say which surface is missing, and rebuilding
something this package already ships is the common case. One real
audit hand-wrote WCAG contrast maths twelve times and a
focusable-element selector six, and evaluated `innerWidth` by hand
while `see kind:"status"` sat there answering exactly that.

**Validating behaviour.** `browser_do` acts, presses and waits;
read the page again after each act rather than assuming the
action worked. `browser_go kind:"network"` mocks, blocks,
throttles or goes offline, so failure paths can be exercised
without breaking anything real. `browser_go kind:"emulate"`
changes the visitor; if the browser refuses a media feature it
was asked for, that feature is dropped rather than retried on
every later navigation, and the refusal is reported in the same
list as a setting this build cannot emulate, so check that list
rather than assuming the condition took.
`browser_check kind:"health"` runs every
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

Some controls have no accessible name at all, an icon button or
a bare input being the common ones, and the outline shows them
as a role on its own. Address them the same way, by giving the
role and no name. That a control needs this is itself worth
reporting: it is what a screen reader user would meet as an
unlabelled button.

```
browser_do role:"button" action:"click"
```

If more than one matches, the refusal lists them with an
`ordinal` you can pass back.

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
- A shot takes the viewport by default, the whole scrollable page
  with `fullPage`, and one element cropped to its own box with
  `within:"button Save"`. Reach for the element form when the
  answer is about one component: a page of tiles to look at a
  button wastes both of you
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
  storage, and the clipboard. `save` writes everything that keeps
  a session signed in to a file, and `load` puts it back in a
  session that never signed in, which is how you test behind a
  login without repeating the login. Cookies apply anywhere; the
  DOM stores belong to an origin, so navigate there first and
  reload after. When you are not on that origin it restores the
  cookies, writes nothing else, and says so, rather than
  reporting a success that leaves you signed out
- `tabs`: list the tabs open, or pass `tab` to switch to one. A
  session drives one tab, so a page that opened another with
  `target=_blank` or `window.open`, as sign-in and payment flows
  do, is live and unreachable until you switch. The tab you leave
  stays open. The browser makes a new tab on its own schedule, so
  a list taken the instant after the click can miss it; list
  again rather than concluding nothing opened
- `dialogs`: decide how alerts and confirms are answered. The
  default is dismiss, and every dialog seen is recorded

### `browser_see`

`page`, `reading`, `announcements`, `element`, `measure`,
`query`, `logs`, `requests`, `sockets`, `downloads`, `shot`,
`vitals`, `heap`, `profile`, `layers`, `hover`, `status`.

- `measure` names two elements, one in `within` and one in `and`,
  and reports the space between them: the gap on each axis, the
  edges or centres that line up, and whether they are the same
  size. It measures border boxes, which is the edge you see. An
  overlap is reported as an overlap rather than a negative gap,
  and two elements side by side are said to span each other
  vertically rather than to have a zero gap there
- `element` takes `why:"<property>"` to trace one CSS property
  through every rule that had a say, with authored source
  positions when a source map exists
- `element` reports what the element says and holds as well as
  what it is called. The accessible name answers a different
  question from the text: a counter reading "42" has a name that
  mentions no number, and a field's name never says what was
  typed into it. Data attributes come back too, since teams hang
  test state on them and the accessibility tree cannot see them.
  It also names the fonts the browser actually painted with,
  which a computed style cannot: a stack reads the same whether
  the first family loaded or the page fell back to the last one
- `vitals` reports what the load cost. Running the other tools
  here does not change it: script injected over the protocol is
  invisible to the browser's long task observer, so an audit
  cannot make the page it audited look slow. That is measured and
  pinned, not assumed
- `profile` records the page's JavaScript for a while and reports
  which functions spent the time, which is the question a long
  task cannot answer. Start it and do the slow thing while it
  runs, or it profiles an idle page. The figures are sampled, so
  they are estimates: a function never caught mid-run does not
  appear at all, and idle time is reported rather than hidden so
  a window spent doing nothing is obvious
- `heap` reports how much memory the page is holding and how that
  compares to the last reading, which is how a leak is found:
  read, do the thing you suspect, read again. A collection is
  forced first unless you pass `collect: false`, and you almost
  never want to, because uncollected garbage is indistinguishable
  from a leak. It measures the JavaScript heap, so memory held in
  an ArrayBuffer or a typed array's backing store does not appear
  there. A first reading reports no direction, because one number
  is not a trend
- `hover` reports what the page does on hover across every element
  that has a hover rule, and whether focus does the same thing. It
  works in two halves and both matter. The stylesheets say which
  elements might hover, which is cheap; holding the state and
  reading the computed style says what actually happens, because a
  hover rule the cascade beat changes nothing anybody can see, and
  those are reported separately as declared and dead. The finding
  worth acting on is a treatment hover realizes and focus does
  not, because a person using a keyboard then gets no equivalent
  cue. Read it as a prompt rather than a verdict: a page may put
  its focus ring on an ancestor or lean on the browser's own, so
  check before calling it a fault. Cross-origin stylesheets throw
  on their own rules, so any hover in them is invisible here and
  the count of unreadable sheets is reported rather than hidden.
  Bounded with `limit`, because each candidate costs a round trip
- `layers` reports what the page asked the compositor to keep: how
  many layers exist, how much texture memory the ones that paint
  are holding, the element behind each, and the reason Chrome
  gives for it. Read it in both directions. Too little promotion
  and an element that animates repaints every frame; too much and
  the page holds tens of megabytes it never needed, which is a
  layer explosion. The reason worth looking for is "Overlaps
  other composited content", because those layers are usually
  nobody's decision: one promoted element forces its neighbours
  up with it. Two honesty notes. Chrome sometimes returns no
  reason at all for a layer that is genuinely promoted, measured
  on a plain `translateZ(0)`, and the report says so rather than
  guessing or implying the layer is absent. And the heaviest layer
  on a normal page is usually the document's own scrolling
  contents rather than anything an author promoted, so read past
  it to the authored ones
- `sockets` reports every websocket the page opened and both
  sides of what was said over it, with each frame's time measured
  from when the socket opened. A request is a question with an
  answer attached and fits the request record; a socket is a
  conversation that outlives any one message, so it does not.
  Frames are bounded like every other buffer here, and the count
  dropped is reported rather than left to be inferred
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
- `wait`: for a selector, text, an attribute reaching a value, a
  number of matching elements, network quiet, a request pattern,
  animations settling, or a duration. Waiting on an attribute or
  a count is how you avoid guessing at a delay: `aria-busy`
  going false is the thing you meant, and 300ms is a hope. A
  request wait takes an optional `status`, without which a save
  that answered 500 ends the wait as happily as one that worked.
  A wait only counts requests that started after it did
- `eval`: run an expression. DOM nodes, functions and circular
  structures are described rather than serialized, and an
  exception comes back as a result with its stack mapped to
  authored source

Every one of those takes an optional `trace`, which is the way to
ask what the browser itself was doing while the action ran. See
below.

### Tracing What an Action Set Off

`trace:"async"` records the browser's own trace stream around the
operation and reports what caused what: each timer paired with
the fire it produced and how late that was, each request joined
to the response that settled it, how many were in flight at once,
and whether any settled out of the order they were sent.
`trace:"frames"` reports what the compositor did instead, for a
page that scrolls or animates badly. Pass both for both.

Four things about it are worth knowing before you reach for it.

**It is a modifier, not a mode.** There is no start and no stop.
The recording brackets one operation, which is why it cannot be
left running by accident.

**A trace only holds what happened while it ran.** This is the
whole reason the work goes inside the recording. A timer installed
before the recording began has no install event, so its lateness
cannot be explained, and a fetch begun earlier has no url. You
cannot ask why something was slow after it has already happened;
bracket the action that causes it instead.

**Tracing is browser-wide and only one can run at a time.** A
second session asking while another records is refused, and told
which session is holding it. The action still runs: losing the
trace never costs you the thing you asked for. While a recording
runs, every session's `see kind:"status"` says so and names who
started it, because every page in the browser is being
instrumented and paying for it.

**Frame figures belong to a layer tree, and the report says how
many contributed.** The frame pipeline names a compositor layer
tree host, never a frame, and nothing in a trace ties the two
together: the event that used to, `SetLayerTreeId`, no longer
exists. So the figures cannot be narrowed to one page by asking
the trace. What the report does instead is count the layer trees
behind its numbers. One means they are this page's and you can
quote them as such, which is the ordinary case for a single page.
More than one means another page or tree in the same renderer
process is included and they cannot be separated. Read that line
before quoting a frame count, rather than assuming either way.

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

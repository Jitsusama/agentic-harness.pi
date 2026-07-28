---
name: browser-accessibility-guide
description: >
  How to audit a web page for accessibility with browser_check
  and browser_see: the keyboard walk, the axe and structural
  rule sets, reading order, live region announcements, contrast
  and target size. Covers what the tools decide, what they
  deliberately refuse to decide, and how to report findings
  without overstating them. Use when asked "is this
  accessible", "check accessibility", "run an a11y audit",
  "will a screen reader work", "can you use this with a
  keyboard", "check the contrast", "is this WCAG compliant",
  or when reviewing a change that touches markup, focus, colour
  or interaction.
---

# Auditing a Page for Accessibility

The tools can measure a great deal and cannot judge most of what
matters. Knowing the line is the skill.

Read the `browser-guide` for the tool surface. This is about
method.

## What the Tools Actually Cover

Automated rules catch somewhere under half of real accessibility
problems, and that fraction is the honest starting point for
every report you write. A page that passes every check here is a
page with no *detectable* faults, which is not the same as an
accessible page.

Never write "this page is accessible" or "WCAG compliant" on the
strength of a clean run. Write what was checked and what came
back.

## The Order to Work In

### 1. Keyboard first

```
browser_check kind:"keyboard"
```

This tabs through the page, records where focus lands, and
restores focus and scroll afterwards.

It is first because a page nobody can operate with a keyboard is
broken in a way no other check reveals, and because it fails
loudly: a focus trap or an unreachable control is a page a
keyboard user cannot finish using.

What it reports, and what each means:

- **Focus trap**: tab cycles within a subset while focusable
  things sit outside it. Whether Escape frees you is reported
  separately, because a trap you can escape is a nuisance and a
  trap you cannot is a dead end
- **Unreachable**: behaves interactively but tab never gets
  there. Usually a `div` with a click handler and no tabindex
- **No visible focus indicator**: nothing changes when focus
  arrives, so a sighted keyboard user cannot tell where they are
- **Focus indicator too faint**: something does change, and it
  cannot be made out. Reported with the ratio it reached, against
  the 3:1 that 2.4.11 asks. A different repair from the one
  above: the rule exists and its colour is wrong
- **Focused off screen**: focus moves somewhere invisible and
  the page appears not to react
- **Positive tabindex**: reorders the whole page, not just the
  element it sits on

### 2. The rule sets

```
browser_check kind:"accessibility"
```

This runs axe's WCAG rule set together with structural rules of
our own, merged into one report so you do not have to know which
found what.

Among our own is autocomplete tokens, WCAG 1.3.5, which axe has
no rule for. A field asking for the user's own name, email,
phone or address without a token cannot be filled by the browser
or a password manager, so somebody who finds typing hard types
it again on every site that asks. The rule reads the input type
before the field's name, because a type is the browser's own
declaration and a name is a guess, and it leaves
`autocomplete="off"` alone: an author who wrote it on a one-time
passcode is right, and overruling them would be this tool
claiming to know better about a decision only they can make.

**Keep two distinctions the report makes.** They are the
difference between a useful finding and a misleading one:

- **WCAG criteria against best practice.** Both matter, and only
  one means the page fails a standard. Never report a
  best-practice finding as a WCAG failure. The summary counts
  them separately for exactly this reason, and the mark at the
  top follows the same line: `FAIL` means a criterion was
  violated, while a page whose only findings are best practice
  opens with `WARN` and says so. A page can be worth improving
  and still not be failing anything
- **Failures against what needs a person.** axe declines to
  judge some things, most commonly text over a gradient or an
  image. Those are reported apart and must be relayed apart

The undecided bucket has a second population worth knowing
about. axe ships five rules switched off, tagged experimental,
that nonetheless test real WCAG criteria. Leaving them off means
2.5.3, label in name, is never checked by anything, so a page
with a button reading "Save changes" whose accessible name is
"Submit" passes an audit while being unusable by voice. They are
switched on here, and their findings arrive as needing a person
rather than as failures, because axe's own doubt about them is
real and not ours to overrule.

So a finding in that bucket means one of two things: axe could
not see enough to decide, or axe does not fully trust the rule.
Either way the answer is to look, and neither is a pass. Say
which criterion it touches and what to check, and do not soften
it into a note.

Name a rule to see the elements and how to fix each.

### 3. What a screen reader would get

```
browser_see kind:"reading"
browser_see kind:"announcements"
```

`reading` is the page in the order it would be read out.
Skimming it catches things no rule does: a heading that says
"Section 2" with no subject, a link called "click here", a table
read as prose, controls whose names make no sense out of
context.

`announcements` is what live regions have said. A form that
validates without announcing, or a status region that announces
every keystroke, both show here and in no rule set.

Be honest about what these are: the browser's accessibility
tree, narrated. That tree is the input every screen reader and
braille display works from, so a fault here reaches all of them,
but no tool in this set runs NVDA, JAWS or VoiceOver, and the
differences between real readers are not modelled. A clean
reading is grounds for confidence, not a claim that any
particular reader behaves.

### 4. Contrast and target size

`check accessibility` covers both. Contrast comes from axe.
Target size is measured here, because axe ships its target-size
rule disabled, so nothing else in the report would answer WCAG
2.5.8. Look for the rule `target-is-big-enough`.

Colours are converted by the browser, never guessed, because
`getComputedStyle` returns `oklch` and `color(display-p3 ...)`
unconverted and a parser that assumed `rgb()` would be
confidently wrong on modern pages.

Target size has an exception that decides most real cases: a
small target with open space around it passes, and the same
target crowded by neighbours does not. Reporting size alone
would fail every link in a paragraph and pass a row of cramped
icon buttons. A link inside a sentence is excepted outright.

One exception is deliberately not claimed. WCAG excuses a
control whose size the browser chose and the author never
touched, and nothing the page can be asked distinguishes that
from a stylesheet choosing the same size. So a default-sized
native control is reported rather than excused, unless it has
the clear space the spacing exception asks for. Judge those
yourself; do not report them as settled failures.

### 5. Under the conditions that break it

```
browser_check kind:"accessibility" widths:[375, 768, 1280]
browser_go kind:"emulate" contrast:"more"
browser_go kind:"emulate" vision:"deuteranopia"
```

Contrast and target size are conditional. A control that clears
24 pixels on a desktop can shrink below it in a mobile layout,
and a colour pair that passes in light mode can fail in dark.

## What the Tools Refuse to Decide, and Why

Each of these is a deliberate silence. Do not fill it with a
guess.

**Whether a focus indicator drawn as a shadow is bright
enough.** An outline over a known background is measured and
reported with its ratio. A box shadow is not: it can be any
number of layers offset in any direction, and which pixels it
changed cannot be read from the computed value. Nor is a ring
over a see-through background, where the colour behind belongs
to some ancestor. Those come back undecided rather than guessed,
so if a page styles focus with a shadow, look at it yourself.

**Whether alternative text is any good.** Rules catch a missing
`alt`. Nothing detects an `alt` reading "image" or a decorative
image described in detail. Read them.

**Whether the reading order makes sense.** The order can be
reported; whether it is comprehensible is a judgment.

**Whether an ARIA role is the right one.** A correctly formed
`role="button"` on something that is not a button passes every
rule.

**Whether design drift is a defect.** Two near-identical greys
may be an accident or a deliberate state.

## Reporting Findings Honestly

Lead with what a person cannot do. "A keyboard user cannot reach
the checkout button" says more than "one serious violation of
4.1.2".

Keep severities as the tools assign them. Do not promote a
best-practice finding to a criterion because it feels important,
and do not describe an undecided result as a pass because
everything else passed.

Say what was not checked. A sentence naming the limits of an
automated pass is worth more than another paragraph of detail
about what it found.

Give the criterion when there is one, and only then. "WCAG 1.4.3
Contrast (Minimum)" is checkable; an invented reference is
worse than none.

Do not read a count off the examples. `check accessibility`
prints a handful of elements per rule and cites a handle holding
every one it found, so the list you can see is not the extent of
the problem. Query the handle when the number matters, which it
does as soon as you say how much of the page a rule affects.
Counting the printed ones understates it by orders of magnitude
on the pages where it matters most.

## A Worked Shape

```
browser_go url:"https://example.com/checkout"
browser_check kind:"keyboard"
browser_check kind:"accessibility"
browser_see kind:"reading"
browser_check kind:"accessibility" widths:[375, 1280]
```

Then report, in this order:

1. What somebody cannot do, in plain words
2. The failures, worst first, WCAG criteria named where they
   apply
3. What needs a person to look at, kept separate
4. What automation cannot cover here

## When Reviewing a Change Rather Than a Page

Take a baseline before the change and compare after:

```
browser_check kind:"compare" baseline:"checkout-before"
# ... the change lands ...
browser_check kind:"compare" baseline:"checkout-before"
```

For accessibility specifically, run `check accessibility` on
both sides and compare the counts. A change that adds one
serious violation is worth blocking even if the page had twenty
already, and a report that only gives the total hides it.

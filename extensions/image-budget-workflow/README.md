# Image Budget Workflow

Brings images entering the context window down to the resolution a human
could actually see, before they are billed for every remaining turn.

## The Fact It Turns On

**A provider bills an image by its dimensions, not by its payload.**
Measured against a real response, a 415,508-character base64 image billed
1,789 tokens: a ratio of about 232 to 1.

Getting this wrong in the other direction is easy and expensive. An
earlier pass here measured base64 characters, divided by four, and called
them tokens, which overstated every image by roughly 48 times and
produced a confident claim that one tool cost $4,644 a month when the
true figure was $96. `billedTokens` exists, and is pinned by a test, so
that error cannot come back quietly.

## Why It Is Safe To Do Silently

A full-screen capture on a 2x Retina display is 3024x1964, which is 5.94
megapixels. Its logical rendering, the thing that was actually on screen
and read, is 1512x982. The pixels between the two are device redundancy,
so discarding them preserves everything a human saw. That makes this a
lossless reduction rather than a quality trade, which is what allows it
to happen without asking.

## Where The Allowance Comes From

One megapixel, about 1,330 billed tokens, and it is set by reading
downscaled screenshots to find where they stop being legible rather than
by argument.

At one megapixel a full window capture of a terminal stays comfortable:
body text, command lines, file paths and a status line all read cleanly.
At 0.6 it is still readable, surprisingly, with terminal text about four
pixels tall, but the smallest row is at the edge of resolvable and a
denser screenshot would fail. So the floor sits above the level where it
was tested to be marginal.

**This is a measured quality trade, not a lossless one**, and the
distinction is worth keeping. An earlier allowance of 1.5 megapixels was
chosen to match the logical resolution of a 2x Retina display, which
made it information-preserving by construction: no pixel a human could
see was discarded. One megapixel is below that, so it does throw away
detail that was in principle visible. It is justified by evidence that
the detail is not needed, which is a weaker claim than geometry and is
held as such.

Set `PI_IMAGE_PIXEL_BUDGET` to trade differently. Raising it to
1_500_000 restores the lossless argument.

## What It Is Actually Worth

Less than first claimed, and the difference is worth recording because
the first figure was arrived at by measuring the wrong thing.

pi resizes to 2000x2000 before any extension sees a result, and that
already does most of the work. Measured on one real paste:

Verified against the provider's own reported usage rather than by
calculation. Median `cacheWrite` on the turn following a full-window
paste:

| | Pixels | Billed |
| ----- | ------ | ------ |
| File on disk | 3024x1964 | not what is charged |
| pi's cap alone | 2000x999 | **3,422 measured** |
| At 1.5 megapixels | 1519x987 | **2,001 measured** |
| At one megapixel | 1240x807 | ~1,330 expected |

An earlier version of this file claimed a 4x saving by comparing against
the size of the file on disk, which is not what a provider charges for.
The payload for a 1518x988 screenshot is still 1.4 MB of PNG and that
costs nothing extra: billing is by pixels, so payload size affects
upload time alone.

## Why It Exists At All

Not for the money. All-time rent on pasted images is about $340.

It exists because **the cost was being paid in capability**: the habit of
pasting screenshots had been given up to avoid a price nobody had
measured. That is a quality attribute traded away for an unmeasured cost,
by a human rather than a controller, and it is exactly the failure this
work exists to prevent. The aim is pasting freely at a quarter of the
price, not pasting less.

## What It Will Not Do

- **Enlarge anything.** Spending the allowance because it is there costs
  tokens and adds no detail the original did not have.
- **Touch an image already within the allowance.** Nothing is re-encoded,
  so no picture pays a compression it did not need.
- **Stack a second compression when it can avoid one.** pi has already
  re-encoded by the time this runs, so where a `read` names a file the
  original bytes are loaded from disk and encoded once. Where there is no
  file, an in-memory image from another tool, the payload is all there is
  and it is re-encoded; that case is a real quality cost and is the price
  of not disabling pi's own resize.
- **Lose a picture to a failure.** Every path that cannot help keeps the
  original. An image the model cannot see is worse than one that costs
  too much.
- **Leave two notes that disagree.** pi writes a note giving the factor
  from its output back to the original. Adding a second note about a
  further change would leave the real factor stated nowhere, and a
  coordinate read off the picture would land in the wrong place. So pi's
  note is consumed and replaced by one that names the true original, the
  size actually sent, and the single factor between them.

## Files

- `budget.ts`: pricing and the allowance decision. Pure.
- `note.ts`: reading pi's dimension note, which is the only place the
  true original size survives, and writing the one that replaces it.
- `rebudget.ts`: one pass over a tool result, with the resizer and the
  original-bytes loader both injected so the behaviour is testable
  without loading the WASM decoder or touching a disk.
- `index.ts`: registration, and the `tool_result` seam.

It runs at `tool_result` because that is where a clipboard paste arrives:
a pasted image reaches the model as a `read` of a temp file. Images
attached to a user message would need the `context` event instead, and
that is deliberately not done here, because a `context` rewrite has to be
deterministic or it invalidates the prompt cache from that point onward
and costs far more than it saves.

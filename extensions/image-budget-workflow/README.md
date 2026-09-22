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

A screenshot from a 2x Retina display arrives at 2858x1428 and bills
about 5,441 tokens. Its logical rendering, 1429x714, bills about 1,361.

Those extra pixels are device redundancy. **The logical rendering is the
thing that was on screen and read**, so discarding the rest preserves
everything a human saw. That makes this a lossless reduction rather than
a quality trade, which is what allows it to happen without asking.

The allowance is 1.5 megapixels, set from what a display shows rather
than from a provider maximum: a full-screen capture on a 2x Retina panel
is 5.94 megapixels and its logical resolution is 1.48, so the allowance
preserves any full-screen logical capture exactly.

pi already resizes to 2000x2000, and that dimension is not configurable,
so this takes the remaining step.

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
  so no picture pays a second compression for no reason.
- **Lose a picture to a failure.** Every path that cannot help keeps the
  original. An image the model cannot see is worse than one that costs
  too much.
- **Hide what it did.** A scaled image is followed by a note naming both
  sizes, so a caller reasoning about a position in the picture maps it to
  the scale the picture is actually at.

## Files

- `budget.ts`: pricing and the allowance decision. Pure.
- `rebudget.ts`: one pass over a tool result, with the resizer injected
  so the behaviour is testable without loading the WASM decoder.
- `index.ts`: registration, and the `tool_result` seam.

It runs at `tool_result` because that is where a clipboard paste arrives:
a pasted image reaches the model as a `read` of a temp file. Images
attached to a user message would need the `context` event instead, and
that is deliberately not done here, because a `context` rewrite has to be
deterministic or it invalidates the prompt cache from that point onward
and costs far more than it saves.

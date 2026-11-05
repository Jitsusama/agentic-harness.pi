# Shared Brief

A pack, not an extension. It is loaded into each reviewer of a round
with `pi --extension`, and must never be auto-discovered, which is why
it lives here rather than under `extensions/`.

## What It Is For

Every reviewer of a round is sent the same brief: the instructions, the
repo's conventions, the change and its diff. Only the last few lines
differ, which is the reviewer's own lens. Anthropic caches a prefix
only where a request marks one, and pi marks the end of the last
message, which on a reviewer's first call is the end of its own lines.
So each reviewer wrote the whole brief to the cache under a key no other
reviewer would ask for, and a round of four paid for the brief four
times. On one round of 206,000 tokens that was about $1.60 a reviewer.

## How It Works

The brief reaches a reviewer as an `@file` argument, which pi puts at
the head of the first message inside a `<file>` element; the lens is the
message typed after it. Before each request this pack splits that first
block where the last `</file>` closes and marks the end of the brief for
caching, with the same marker pi chose for the rest of the request.

It leaves a request alone when it is not in Anthropic's shape, when the
first message does not open with a file, when nothing follows the files,
when the request marks nothing (caching is off), and when the request
already carries the four markers Anthropic allows.

A mark only helps a reviewer that asks after the brief was written, so
the round starts one reviewer first and the rest once its first response
has begun. That half lives in the round, not here.

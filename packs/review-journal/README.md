# Review Journal

A pack, not an extension. It is loaded into a reviewer subagent with
`pi --extension`, and it must never be auto-discovered, which is why it
lives here rather than under `extensions/`: pi scans that directory, and
this tool belongs to a reviewer rather than to the session that
dispatched one.

## What It Is For

A reviewer investigates for ten minutes and says everything it found in
one message at the end. Anything that interrupts it therefore costs the
entire review, and rounds have been lost that way after real work: one
cost $50.63 and produced nothing.

The rest of the review substrate answers that by recovering the answer.
The transcript is kept, whole entries are salvaged from an answer cut
off mid-sentence, and a stopped reviewer is asked for the findings it
had already formed. All of it depends on the answer arriving.

This does not. A finding written down when it was found is already
safe, so an interruption costs the line being written and nothing
above it.

## How It Works

One tool, `record_finding`, appending one JSON object per line to the
file named by `SUBAGENT_JOURNAL_PATH`. The supervisor clears that file
before the spawn, so a second attempt is never credited with the first
one's findings, and reads it back afterwards onto the run's result.

The tool does not validate the shape beyond it being a finding at all.
The round reads these the same way it reads an answer and warns about
what it cannot use; a tool that argued with a reviewer about a missing
field would spend the reviewer's remaining budget on the argument.

It reads a finding sent as an object, a batch sent as an array, and
either of those sent as JSON text, because a reviewer's intent is not in
doubt in any of them. That last one is not a courtesy. The first live
run sent its findings as text, was refused six times, gave up, and
recorded nothing: a tool holding out for the right encoding loses
exactly what it was built to keep. What stays refused is a sentence,
which is not a finding in any encoding.

Findings recorded and then repeated in the final answer are counted
once. Where the same finding arrives twice, the answer's telling wins,
since it is written after the investigation rather than during it.

---
name: review-council-format
description: >
  Output contract for a discovery reviewer in a review_ask
  council round: the answer's envelope, recording findings as
  they are found, and what makes one worth reading. The shape of
  one finding is review-finding-format, loaded beside it. Loaded
  into each reviewer subagent via --skill.
---

# What a Discovery Reviewer Answers With

Answer with one JSON object. Prose outside it is ignored, and prose
instead of it loses your whole pass. With nothing to say, answer
`{"findings": []}` rather than explaining that you found nothing.

```json
{ "findings": [ { "...": "one finding" } ] }
```

## Write Each One Down When You Find It

When a `record_finding` tool is available, call it the moment you are
sure of a finding, with that one finding, and carry on. Then include
everything in your final answer as normal.

This is not bookkeeping. A review can be interrupted, by a deadline or
by the provider, and an answer that never arrives takes every finding
in it. Rounds have been lost that way after ten minutes of real work.
What you have recorded survives that; what you were saving for the end
does not.

So record early and record often. Do not batch them up to record at the
end, which is the failure this avoids, wearing a different hat.

The tool answers with a key for each finding, such as `R1a2b3c`. Put
it on that finding's entry in your answer as `"recorded": "R1a2b3c"`,
however you reword the finding there. A finding recorded and then
repeated with its key is counted once. Repeated without one, it is
counted once only when its subject is word for word the same, and
twice otherwise.

## Ask for Independent Reads Together

When you know of two or more reads, searches or listings that do not
depend on each other, issue them in the same turn rather than one per
turn. Every turn re-reads everything you have gathered so far, so the
same reading spread over fewer turns costs less. This is about how you
read, not how much: read everything you otherwise would.

It does not touch the rule above. Findings are still recorded one at a
time, the moment you are sure of each; a recording call can simply
share a turn with the next reads.

On a paired round over the same change, reviewers told this took 100
turns between them rather than 156 and found the same things, 35 of 37
landing in the same place.

## What a Finding Carries

Each finding is the shape [`review-finding-format`](../review-finding-format)
gives: its fields and labels, the three location kinds, and what happens
to a field that will not read. That skill is loaded beside this one, so
answer in its fields and no names of your own.

## What Makes a Finding Worth Reading

Your pass is for discovery. Another consolidates and a third pushes
back, so a finding you are unsure of is still worth raising as long as
the uncertainty arrives with the evidence that would settle it. Put
that in `confidence` and say so in `discussion`.

Go and read the code. A finding grounded in something you opened is
worth ten that restate the diff, and a finding that only restates the
diff wastes the author's time twice: once reading it and once saying so.

A symptom you observed may be reported on the observation alone. A
mechanism, the *because* clause, must quote the responsible code to a
file and line, and a mechanism you have not found is a question, not
a claim held at severity. A confident causal narrative unsupported by
source reads as diagnosis and sends the author to fix the wrong line,
which costs more than the finding was worth.

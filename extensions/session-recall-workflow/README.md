# session-recall-workflow

Registers `session_recall`, which searches the session's own log or
reads one entry of it by id or by paragraph reference.

A compaction keeps a summary and a recent tail in the context, and
everything else leaves it while staying on disk. This tool is how the
model gets that back. Replays of twenty real sessions scored better on
questions about the earlier work with it than without, whatever summary
the session had: on 27 of 133 exam questions the model chose to call
it, and scored 0.26 higher on those.

## How It Answers

- **Search** matches any word of the query, not the phrase, because a
  model asks in its own words and the log almost never holds them as
  one string. Rarer words count for more, so a file name outranks the
  everyday words around it. Each hit shows about 900 characters around
  its first match, under the entry id that reads it in full.
- **A tool call reads with its result,** under the assistant entry that
  made it, since each alone answers half a question. The tool's own
  earlier calls are left out, or every search would find the last
  one's hits again.
- **A page holds ten hits or about 4k tokens,** whichever comes first.
  Recall lands in the room a compaction just made, and an unbounded
  answer could put back enough to bring on the next one. What a page
  leaves out is stored through the result store and cited by handle,
  and the page names the ids it left for later.
- **An entry read names its neighbours,** the entry before it and the
  one after, so the model can step through what was said around it.
- **A paragraph reference reads by words, not place.** The compaction's
  excerpts name each quote as `p:` and a hash of its text, when this
  tool is active. Passed as `entryId`, a reference reads the latest
  entry saying that paragraph, so it still finds it after a host
  rebuilt the log with new ids. An id that is not there says the log
  may have been rebuilt, and to search instead.

The branch is what it searches: the path from the root to where the
session is now, which is the history the summary was written over.

## The Summary Note

Every summary the harness writes ends with one line saying the log can
still be searched, and read by id or by a quote's reference,
contributed through the compaction workflow's `SUMMARY_CONTRIBUTIONS`. A model that has just lost its history has no
other reason to go looking for it. A summary pi writes itself, when
the harness's summariser declines, carries no contributions and so no
note; the tool is still registered and described.

`/compaction-status` says whether the tool is active, how many of the
branch's summaries mention it and how many times it has been called.
A tool that is there and never called is the case worth seeing.

## Why `-workflow`

It registers a tool over session-scoped data and contributes to the
compaction workflow, which is the same reading the result store took:
`-integration` bridges an external service, and there is none here.

## Files

| File | Holds |
|---|---|
| `index.ts` | Tool registration, bounding and the summary note |
| `status.ts` | Recall's section of `/compaction-status` |

The search itself is pure and lives in `lib/internal/recall/`.

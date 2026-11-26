# Unread Write Interceptor

Refuses a write that would replace a file its conversation hasn't
read whole, or one that changed since the conversation last read or
wrote it.

## What It Does

pi's write tool replaces a file whole, whether the agent read it or
not. On 25 November a session wrote a state file of asks over the one
already there, never having read it, and every ask in it was lost.

Each conversation keeps the stamp each file had (its inode, size and
modification time) when it last saw all of it. A write is refused when
the file is there, holds something, and either has no stamp or no
longer matches it. The refusal says to read it first, or to change it
with edit.

- What counts as seeing all of it: a write whose text the file still
  holds when it ends; a read from the first line with no limit that
  came back whole, with the file the same at its end as at its start;
  or an edit that began from a version already seen and moved the
  file's size by just its own replacements, so edits sent together
  each count from the one before. A slice, a truncated read or an edit
  alone shows a part, so it stamps nothing, though a slice of a file
  still as it was seen keeps its stamp. A file too long for one read
  is changed with edit.
- A same-size change within the filesystem's modification-time
  resolution reads as no change, and an edit that adds or takes away
  lines in a file with CRLF endings counts as unseen, since pi writes
  its new lines with the file's own endings, moving its size by more
  than the edit's text.
- A compaction or a move in the session tree forgets every stamp,
  since the context may no longer hold what was read.
- A new file, or an empty one, has nothing to lose, so it is never
  refused.
- The guard, `unread-write`, redirects: a write sent again over the
  file as it then was goes through, since the agent may know a file its
  own command made. The override is for that file as it stands: once
  the file changes, a write over it is refused anew.
- A command that rewrites files the conversation wrote, as
  `pnpm lint:fix` reformatting them, moves their stamps, so the next
  write over each is refused once. Read the file again, or use edit.
- The stamps live in a session slot: a reload keeps them, a new or
  resumed conversation starts with none, and a host keeps each
  conversation's apart, dropped when it closes.

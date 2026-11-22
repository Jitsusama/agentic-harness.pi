# Reply Cause Interceptor

Follows a reply to the person that states why something
happened as settled fact, with no test behind it, with a note
telling the model to say which it is.

## What It Does

A cause told as fact is passed on as fact. The mesh refuses a
message that states one before it goes
([`mesh-workflow`](../mesh-workflow/README.md)); this does the
same job for what an agent tells the person directly.

A reply streams to the person as it is written, so by the time
pi finalizes it there is nothing left to hold, and judging takes
up to about 5 seconds. So the reply is never held. Once pi ends
a finished reply, the classifier judges each paragraph and list
item ([`claims.ts`](../../lib/prose/claims.ts)). When a part
states an untested cause, the model is sent one note quoting it,
as a follow-up that starts a turn of its own. The note asks it
to tell the person in a line whether the cause is a hypothesis
or what tested it.

## What Is Judged

Only a finished reply: an assistant message pi stopped for good,
with no tool call left to run. A reply cut off by the person, an
error or the length limit is left alone, and so is its thinking:
only its text blocks are judged.

Two replies are never followed by a note:

- **The answer to a note.** The reply after a note is not
  judged, so a note can't follow a note. The person's next word
  clears that.
- **A reply the person has moved past.** When the person speaks
  while a reply is being judged, its note is dropped.

## The Switch

It is the mesh's `untested-cause` guard, so one switch covers a
cause told as fact wherever it is told. Set `off`
(`/guards untested-cause off`), no reply is judged and no
reply's text goes to the classifier's provider. Otherwise every
finished reply's text goes there. Other guards, the mesh's use
of this one among them, still look while `off` and report what
they would have refused; a note refuses nothing, so there is
nothing to report, and judging would only send the text away.
With no classifier, an error or a slow answer, nothing is
judged and nothing is said.

A note costs one turn. It refuses nothing, so the guard's
`block` and `redirect` modes act alike here.

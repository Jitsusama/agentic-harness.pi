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
pi settles there is nothing left to hold, and judging takes up
to about 5 seconds. So the reply is never held. Once pi settles,
the classifier judges each paragraph and list item of the last
reply ([`claims.ts`](../../lib/prose/claims.ts)). When a part
states an untested cause, the model is sent one note quoting it,
as an automated turn, as every turn the harness starts itself
is, so nobody reads it as the person's words. The note asks it to
tell the person in a line whether the cause is a hypothesis or
what tested it.

## What Is Judged

Only the last reply before pi settles, when the person's own
words are among what it answers: an assistant message pi stopped
for good, with no tool call left to run. pi runs everything
queued, and retries, before it settles once, so whose words a
reply answers is read over that whole stretch: one the person's
words began from idle, or that they queued or steered words
into, answers them, and its last reply is the one they read. A
stretch an automated turn, a peer's steer, a job's result,
another custom message or the host's continuing began, with no
word of the person's in it, is not judged. Nor is the run the
harness tries again after a model's error
(`model-retry-workflow`), since its try comes as a job's
result, though its reply answers the person's words. Words the person sends after a
stretch's last run has ended wait for the run they begin. A reply
cut off by the person, an error or the length limit is left
alone, and so is its thinking: only its text blocks are judged,
with fenced code blocks left out, open or closed and at any
indent, since they quote rather than say. Each part is one
classifier call, up to 12 a reply. The floor was tried on 106
replies judged whole and 54 mesh messages judged part by part.

It reads the reply as the session keeps it, so one another
extension replaced, a withheld reply among them, is judged as
replaced. A conversation on the shared host is judged though it
has no screen of its own, while a window views it, since the
person talks to it from the launcher; one running in the
background has no one reading, and nor has print or JSON mode,
so neither is. On the host the person's typing is not seen
until sent, so a note there is not held back for an ask still
being typed.

Two replies are never followed by a note:

- **The answer to a note.** The run a note starts began with
  an automated turn, no word of the person's, so it is not
  judged and a note can't follow a note. When the person speaks
  during it, its last reply answers them and is judged.
- **A reply the person has moved past.** When anything comes
  in or another run starts while a reply is being judged, or
  by then a message waits, the person has typed their next ask
  or is away, its note is dropped.

The note quotes the flagged part as the reply's own words, to
weigh rather than follow, since a reply can pass on words from
a page or a peer.

## The Switch

It is the mesh's `untested-cause` guard, so one switch covers a
cause told as fact wherever it is told. Set `off`
(`/guards untested-cause off`), no reply is judged and no
reply's text goes to the classifier's provider. It reads the
mesh's classifier setting too, as each conversation has it on
the shared host: `PI_MESH_CLASSIFIER=off` judges no reply
either, and the classifier it names as `provider/model` judges
replies as it does messages, so replies go only where mesh
messages already go. Otherwise
each judged reply's text goes to the classifier's provider, with
the secrets the harness knows scrubbed first. The classifier is
chosen apart from the session's model, so a session on a local
model still sends its replies there unless one of those is off.
Other guards, the mesh's use of this one among them, still look
while `off` and report what they would have refused; a note
refuses nothing, so there is nothing to report, and judging
would only send the text away.

With no classifier found, or a lookup that failed or was slow,
nothing is judged and nothing is said in the session. Its log gets a
`reply-cause-unjudged` entry saying why, once for each reason,
with the first line of what went wrong, its secrets scrubbed,
and each note sent leaves a `reply-cause-note` entry, so notes
can be counted. A lookup that failed is tried again at the next
reply, so logging in later starts the judging; one still out
after 2.5 seconds is waited on again at the next reply rather
than started anew, and one still out after three replies is let
go and looked for anew. A window that stops viewing the
conversation, or the guard switched off, while a reply is
judged drops its note.

A note costs one turn. It refuses nothing, so the guard's
`block` and `redirect` modes act alike here.

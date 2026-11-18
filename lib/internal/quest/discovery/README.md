# Discovery

Finding quests across the tree: the walk that builds the index and what it
reads and remembers between calls, the reverse-mention index, which quest
a working directory belongs to, and the table of contents with the marks a
quest is drawn with. The seed the walk leaves for the next process stays
one folder up, beside the modules its hash covers.

On a host, where every conversation shares one thread, a known tree is
answered from its last signed walk and signed again off the thread
(`off-thread.ts`) once that walk is a few seconds old. Quest writes made
through the workflow in this process, a quest made, removed or given its
README, a session's start, the quest tool's actions, and an ask after a
minute unasked still sign at once, unless a signing off the thread is
under way: that one is walked again at once for this process's writes
made during it, up to three walks, and answers them when it ends. An
edit made through pi's write and edit tools, or by another process,
shows by the next signing.

A file at `~/.local/state/pi/agentic-harness.pi/quest-workflow/signing-paused`
(under `XDG_STATE_HOME`, and the realm's own folder in a realm other
than home), looked for at most every five seconds, pauses signing off
the thread on every host: each answers from its last walk however old,
and walks on its thread only for its own writes, or a quest made,
removed or given its README. Remove the file to resume.

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
minute unasked still sign at once, unless the host holds back: while a
signing off the thread is under way, which walks again at once for this
process's writes made during it until one ends with none; while a
thread let go at its wall hasn't stopped, since its disk still hangs;
or while signing is paused. Holding back, every ask and quest action
answers from the last walk, and the desktop's lists, which wait for a
walk signed after them, fail rather than walk on the thread. An edit
made through pi's write and edit tools, or by another process, shows
by the next signing.

A file at `~/.local/state/pi/agentic-harness.pi/quest-workflow/signing-paused`
(under `XDG_STATE_HOME`, and the realm's own folder in a realm other
than home), looked for at most every five seconds, pauses signing off
the thread on every host: each answers from its last walk however old,
its own writes too, and walks on its thread only for a quest made,
removed or given its README, or a tree it never walked. Each host says
in its journal when it pauses and resumes. Remove the file to resume.

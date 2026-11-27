# Discovery

Finding quests across the tree: when to walk (`discovery.ts`), the walk
that builds the index (`discovery-walk.ts`) and what it reads and
remembers between calls, the reverse-mention index, which quest
a working directory belongs to, and the table of contents with the marks a
quest is drawn with. The seed the walk leaves for the next process stays
one folder up, beside the modules its hash covers.

On a host, where every conversation shares one thread, a known tree is
answered from its last signed walk and signed again off the thread
(`off-thread.ts`) once that walk is a few seconds old. A signing's reads
run on a thread of their own (`tree-thread.ts` running `tree-read.mjs`),
which answers the host's thread in one message, so a long turn there
holds them back by one turn rather than one per read. A file the thread
skips is answered from what the host held of it when the signing
began, so the host's thread reads nothing itself; a signing the memo
was let go during is dropped. Between signings
the thread reads again only the quests that changed under it: those this
process wrote, those a quest tool action names, and those the root
gained, lost or that took their README. An action whose write rests on
quests it doesn't name, or that comes over a minute after the last walk,
waits on a whole signing off the thread. An edit made through pi's write
and edit tools, or by another process, shows by the next signing.

Where the login has a runtime folder, as on optimus, each quest write
the workflow makes, and each quest file a session's write or edit tool
changes, is noted in a journal beside the quest locks
(`../write-journal.ts`), and each ask reads the journal's new lines and
re-reads just the quests they name. Another process's writes then show
at the next ask, so a host signs its tree whole only every five minutes,
and an action acts on the journal for those five minutes rather than
waiting on a signing after one. A process still running code from
before the journal notes nothing until it restarts, so its writes show
by that five-minute signing, as edits by hand or through bash do. A quest mycelium newly shares shows at once, since the root's
stamp moves, but its changes to a quest already there show by the
five-minute signing too.

A full journal is moved aside to `.old`, and a reader whose mark lies
in it reads on through it. A journal replaced, moved twice, grown past
what one read takes, or found to be a link or anything but a plain
file can't say what it missed: that starts a whole signing off the
thread, and an action waits on it. Nothing at the journal's name is
followed or waited on, so the worst it costs is whole walks off the
thread. With no runtime folder, as on the Mac, there is no journal, and
the timings above hold.

What the walk finds wrong with the tree's layout, such as a quest folder
with no README, goes to a record in the workflow's state folder
(`layout-faults.ts`) rather than onto the screen at every start and
reload. A quests root that won't list is read one way on both threads
(`root-standing.mjs`): with nothing at it or along it, as before a
fresh data folder's first quest, it is an empty store; with something
there (a dangling link, a file, a folder that can't be listed or
searched) it is a fault, dropped at once when the root lists again.
The record holds what the latest walk of a quests root found,
each fault with when it was first seen, so a fixed fault drops out; a
fault new to it goes to the system's journal at warning, once. A reader
tells a tidy tree (no record) from a record it can't read.

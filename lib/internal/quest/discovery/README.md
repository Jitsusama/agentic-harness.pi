# Discovery

Finding quests across the tree: when to walk (`discovery.ts`), the walk
that builds the index (`discovery-walk.ts`) and what it reads and
remembers between calls, the reverse-mention index, which quest
a working directory belongs to, and the table of contents with the marks a
quest is drawn with. The seed the walk leaves for the next process stays
one folder up, beside the modules its hash covers.

On a host, where every conversation shares one thread, a known tree is
answered from its last signed walk and signed again off the thread
(`off-thread.ts`) once that walk is a few seconds old. Between signings
the thread reads again only the quests that changed under it: those this
process wrote, those a quest tool action names, and those the root
gained, lost or that took their README. An action whose write rests on
quests it doesn't name, or that comes over a minute after the last walk,
waits on a whole signing off the thread. An edit made through pi's write
and edit tools, or by another process, shows by the next signing.

What the walk finds wrong with the tree's layout, such as a quest folder
with no README, goes to a record in the workflow's state folder
(`layout-faults.ts`), once a fault however many sessions start over it,
rather than onto the screen at every start and reload.

# Discovery

Finding quests across the tree: the walk that builds the index and what it
reads and remembers between calls, the reverse-mention index, which quest
a working directory belongs to, and the table of contents with the marks a
quest is drawn with. The seed the walk leaves for the next process stays
one folder up, beside the modules its hash covers.

On a host, where every conversation shares one thread, a known tree is
answered from its last signed walk and signed again off the thread
(`off-thread.ts`) once that walk is a few seconds old. This process's own
writes, a quest made or removed, and the quest tool's actions still sign
at once; `discoverQuestsFresh` signs at once for any other answer a
decision rests on.

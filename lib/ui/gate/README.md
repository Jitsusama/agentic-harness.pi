# Gate

A gate is a prompt that holds work until the person answers it. This
folder keeps one on a screen at a time (`gate-queue.ts`), docks it
above a live editor (`gate-dock.ts`), leaves what it was answered
in the transcript (`gate-record.ts`), and counts the gates a screen
has docked or waiting, for a host that must not load pi
(`screen-gates.ts`).

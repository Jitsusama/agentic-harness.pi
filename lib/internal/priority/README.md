# Priority

The machine's job queue that the priority workflow wires:
what a heavy command is, whose turn comes next, what the machine can
take, and how a turn is waited for, run and recorded.

Many entries because each part of the queue changes for its own
reason: the readings of the machine (`room.ts`, `room-darwin.ts`,
`uplink.ts`, `call.ts`), the turn rules (`next-turn.ts`, `bounds.ts`),
the order walks of World's objects wait in, by the class World's push
gate ranks them (`walk-order.ts`, `push-class.ts`), what a command
tells the queue through a variable its step sees (`step-variable.ts`),
when a job is due to start (`due-to-start.ts`), what its waiter is
told once it is late (`late.ts`), the folder and its
record (`folder.ts`, `queue-record.ts`), and the shell's side of a
turn (`turn.ts`, `clock.ts`, `queued-exec.ts`). The readings are the
first to move to a folder of their own once one more joins them.

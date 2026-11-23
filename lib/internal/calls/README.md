# Calls

Whether the person is on a call, asked one way for everything that
holds work back for one: the machine's queue (`priority/call.ts`),
which starts no heavy work during a call, and a prompt cache's warm
(`cache/calls.ts`), which waits one out.

## Files

- **`probe.ts`**: asking `a-call-is-on` by its exit, answering by its
  own timer and killing a program past its time with all it started,
  and telling its caller, on each ask, when the program can't be asked:
  missing, refusing its arguments, or there but unable to run. Each
  caller decides how often to say it, and to whom.

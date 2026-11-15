# Peer

One session as a peer on the mesh, split by what each part answers
for. The extension's `index.ts` makes the peer's state once as it
loads, then hands it to each part in turn; a part reads and changes
that state and calls only the parts made before it, so none imports
another in a circle.

- `mesh.ts`: the paths and settings a peer runs with, its shared
  state (`MeshState`), and the shapes its parts pass along.
- `state.ts`: the state as the extension loads, before any session
  starts: transport, presences, leases, and the helpers that pause,
  move and talk for it.
- `waits.ts`: the clocks over the holds a peer waits on and what it
  raised for the person.
- `handing.ts`: handing messages to the model, in full or as a
  glance, with a turn or without.
- `steerer.ts`: the person's words and acts from outside the window,
  through the steer inboxes.
- `hearing.ts`: who is still there, taking each message once, judging
  the attention it gets, and chasing what went unanswered.
- `heavy.ts`: leasing the files, checkouts and heavy work a session's
  tool calls change and run.
- `start.ts`: a session starting as a peer, and its catch-up.
- `runs.ts`: the session through its runs, and letting go as it
  shuts down.
- `bus.ts`: what other extensions say over pi's bus that the peer
  keeps, and what will wake it.
- `commands.ts`: how the peer draws on screen, and its `/host` and
  `/mesh` commands.
- `local.ts`: what the mesh tools see of the peer.
- `looks.ts`: asking hosts about the person's looks, and resolving
  those whose change or quest ended.

# Engine Tests

Conversation ownership and isolation through the engine's public entry.
Fake cleanup callbacks stand in for pi runner disposal; no provider or live
host is started by these tests.

hosted-agent.test.ts and engine.test.ts are the exceptions. The first runs
fixtures/hosted-session.mts in child node processes, beside pi's own agent,
on pi's scripted provider. The second runs fixtures/hosted-engine.mts, a
host's life one start at a time in a sealed folder: open, a refused key,
a stop and resume, a kill mid-tool and the start after it, and ordinary
pi reading the file. Both need a pi built with the host's patches, named
by PI_HOST_PACKAGE_DIR, and are skipped without one. They sit in the
process lane, since they spawn node from node.

- `fixtures/`: programs a test runs in a node process of its own, and
  the probe extension the engine's fixture gives pi to load.

# Engine Tests

Conversation ownership and isolation through the engine's public entry.
Fake cleanup callbacks stand in for pi runner disposal; no provider or live
host is started by these tests.

hosted-agent.test.ts is the exception. It runs fixtures/hosted-session.mts
in child node processes, beside pi's own agent, on pi's scripted provider.
It needs a pi built with the host's patches, named by PI_HOST_PACKAGE_DIR,
and is skipped without one. It sits in the process lane, since it spawns
node from node.

- `fixtures/`: programs a test runs in a node process of its own.

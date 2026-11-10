# Shared pi Host

The runtime that holds several pi conversations in one process. It is not
an auto-discovered extension. Hosts install the session seam before loading
extensions and dispatch every callback within its conversation.

- cutover/: moving every live pi into the realm's host, each ending
  itself once free, for `scripts/host-cutover.ts`.
- engine/: conversation ownership and pi's durable agent adapter.
- screen/: one persistent pi screen per conversation, which viewers join.
- service/: socket protocol, transport and the persistent restart roster.

Service transport and persistent screens are separate pieces built beside
the engine. The engine's first landing owns identity, environment and the
live registry only; it does not yet run durable generations or claim parity.

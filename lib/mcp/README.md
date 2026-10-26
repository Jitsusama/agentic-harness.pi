# MCP

A server-agnostic MCP client: connecting to a server, mapping its tools
onto pi's, and rendering calls and results. `index.ts` is its public
surface and says how a host puts the pieces together. The files here are
the connection, the store and the content utilities; three folders hold
the seams:

- `frontend/`: the front-end seam, through which a provider shapes,
  confirms and renders one server's tools, registered directly or over
  pi's event bus.
- `render/`: how a call, its result and the list of discoverable tools
  are drawn.
- `surface/`: which of a server's tools pi declares and how (directly,
  on demand, or not at all), the manager that reconciles that with pi,
  and the search and run helpers for tools loaded on demand.

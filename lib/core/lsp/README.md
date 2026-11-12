# Core's LSP

Code intelligence behind one contract that does not care which
backend answers. The files at the top hold the contract, the
registry a backend joins and is resolved from, the servers this
package knows, the checks on a backend registered from across a
package boundary, and the formatting of what comes back. A
downstream package, such as an editor's, registers a backend
ahead of the standalone one to take over when it is there.
`index.ts` is the whole surface.

## Folders

- `standalone/`: the backend this package ships, which spawns and
  supervises the language servers itself: the pool that routes
  each file to its servers and stops idle ones and those whose
  project folder is gone, one server over
  stdio, and the mapping between the tool's positions and LSP's.

# Mesh

The mesh's library: how peers on one machine find each other, send,
hold, steer and hand work on, and how a need finds the cell working on
it. `extensions/mesh-workflow` wires it into pi.

Many entries because each file is one rule of the mesh that changes for
its own reason (addresses, leases, liveness, needs, steering, retention),
and the extension imports each by name; folders would only add a level
every import then names.

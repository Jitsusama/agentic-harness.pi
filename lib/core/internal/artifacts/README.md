# Artifact Ownership

Shared lifetime rules for stored tool results and captured web bundles.
Directories carry an atomic owner record. Dead plain-pi owners can be
reaped; hosted artifacts remain until the durable roster says the session
is unheld. Unknown ownership is preserved rather than guessed from age.

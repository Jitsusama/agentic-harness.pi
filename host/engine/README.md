# Conversation Engine

The host's pi comes from its own install, never from this package's
dependencies: loadHostPi imports pi, pi-agent-core, pi-ai, pi-durable and
chord from the install's folder and refuses, naming each missing patch,
unless it carries every host seam core.nix's modules/pi applies
(the agent interface, the committed turn and the hosted screen). A host
refuses this before it opens any conversation.

SessionHost installs the public session seam before any hosted extension
loads. Register each conversation's stable pi id, absolute session file,
working folder, environment and cleanup callback before publishing leases.
The service keeps the durable restart roster; this module publishes only
live ownership at hostRegistryPath.

Run dispatches through withSession. Environment snapshots are independent
copies and PI_SESSION_ID is set to the conversation id. Launch hints are
consumed once. Closing stops new dispatch, parks the owner, waits for its
cleanup callback and then releases its slots and list entry. A failed
cleanup or publication keeps the owner held and refuses further dispatch;
a retry does not repeat cleanup that already completed. Sibling sessions
remain usable. Dispose refuses until the host has no conversations.

The cleanup callback must abort active work, emit pi's session_shutdown and
dispose timers, subscriptions and runner resources. The optional stamp
callback emits on the conversation's pi event bus: close sends closed;
stop sends signalled for host restart, without marking a deliberate quit.
Stamps do not recursively close. Reload keeps ownership and slots, not
calling close or stop: `reload(id, { reason })` runs the registration's
optional reload callback under withSession, joins a reload already
under way, refuses an unknown or closing conversation, a tree (`onto`)
and a runner with no callback, and leaves a conversation whose reload
failed held and usable. The durable AgentSession adapter and process-child
reconciliation are subsequent work, not implemented by this first seam.

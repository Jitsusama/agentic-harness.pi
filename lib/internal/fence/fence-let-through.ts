/**
 * What the fence lays of its own accord: in the runtime folder, by name
 * within it, the doors it lets through read-only and pi's own folder,
 * and outside it, the folders it covers after a machine's grants. Its
 * own module, since two readers need the same names: the fence, which
 * lays them, and a machine's grants (`../sandbox/machine-grants.ts`),
 * which must never bind over one and undo how the fence laid it.
 */

/**
 * The runtime folder's doors the fence lets through, read-only, Nix's
 * first, which alone a language server keeps. Why each is here, and why
 * nothing else is, is said where the fence lays them (`fence.ts`).
 */
export const LET_THROUGH = [
	"nix-untrusted.sock",
	"pi-agent.sock",
	"pi-agent",
	"daemons/jobs-broker.sock",
	"pi-clipboard",
	"pi-fence-display",
] as const;

/** pi's folder in the runtime folder, as `fence-copy.ts` names it. */
export const FENCE_RUNTIME_FOLDER = "pi-fence";

/**
 * Folders outside the runtime folder the fence covers with an empty one
 * after it lays a machine's grants, so no grant brings back the system
 * bus or X's sockets: the system bus's folder and X's socket folder.
 */
export const COVERED_AFTER_GRANTS = ["/run/dbus", "/tmp/.X11-unix"] as const;

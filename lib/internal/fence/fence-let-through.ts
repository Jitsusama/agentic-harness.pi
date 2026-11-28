/**
 * What the fence lays in the runtime folder of its own accord, by name
 * within it: the doors it lets through read-only, and pi's own folder.
 * Its own module, since two readers need the same names: the fence,
 * which lays them, and a machine's grants (`../sandbox/machine-grants.ts`),
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

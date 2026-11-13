/**
 * The variable that turns pi-spawner off, apart from the spawner itself:
 * a session's restart carries it, and the scripts that write a restart
 * run under plain node, where pi's own packages, which the spawner
 * imports, aren't there to load.
 */

/** The variable that turns pi-spawner off: `off`. */
export const SPAWNER_VARIABLE = "PI_SPAWNER";

/**
 * Whether the environment `env` leaves pi-spawner to start the agent's
 * commands: always, unless it says `off`. It was asked for with `on`
 * while it was new, and a session started that way still says so.
 */
export function spawnerWanted(env: NodeJS.ProcessEnv): boolean {
	return env[SPAWNER_VARIABLE] !== "off";
}

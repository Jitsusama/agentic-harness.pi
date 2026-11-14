/**
 * The variable that asks for pi-spawner, apart from the spawner itself:
 * a session's restart carries it, and the scripts that write a restart
 * run under plain node, where pi's own packages, which the spawner
 * imports, aren't there to load.
 */

/** The variable that asks for pi-spawner, while it is new: `on`. */
export const SPAWNER_VARIABLE = "PI_SPAWNER";

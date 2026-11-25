/**
 * A held pi copies through the terminal showing it, as well as its own
 * machine's clipboard. A holder (`MYCELIUM_HELD`) may run pi on one
 * machine while the person sees it through an attach on another, which
 * leaves pi none of the SSH markers that make it send OSC 52; so a copy
 * reached only the clipboard of the machine pi ran on. pi reads
 * `PI_CLIPBOARD_OSC52` on every copy, so setting it as the extension
 * loads reaches every copy the session makes.
 */

type Env = Record<string, string | undefined>;

/** pi's own switch for sending a copy to the terminal as OSC 52. */
const OSC52 = "PI_CLIPBOARD_OSC52";

/**
 * Turns on OSC 52 copies for a pi a holder keeps, leaving a value the
 * person set as it stands and an unheld pi as pi has it.
 */
export function copyThroughHeldTerminal(env: Env): void {
	if (!env.MYCELIUM_HELD) return;
	if (env[OSC52] !== undefined) return;
	env[OSC52] = "1";
}

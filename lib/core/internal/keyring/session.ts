/**
 * What an extension keeping credentials in the keyring does with each
 * session: shows the person what the keyring documents say, and moves a
 * plain credentials file left from before into the keyring at once,
 * rather than on the first tool call that reads it.
 *
 * The move runs beside the session's start, never in front of it: a
 * locked keyring may ask the person to unlock it, and pi must stay live
 * while it asks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onKeyringNotice, sayKeyringNotice } from "./notices.ts";
import { reasonOf } from "./store.ts";

/** Show keyring notices in each session, and run `move` as it starts. */
export function keepCredentialsInKeyring(
	pi: ExtensionAPI,
	label: string,
	move: () => Promise<void>,
): void {
	let stopListening: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		stopListening?.();
		stopListening = onKeyringNotice((notice) => {
			ctx.ui.notify(notice.message, notice.level);
		});
		move().catch((error: unknown) => {
			sayKeyringNotice({
				level: "warning",
				message: `${label} could not be moved into the keyring: ${reasonOf(error)}. The plain file is kept.`,
			});
		});
	});

	pi.on("session_shutdown", async () => {
		stopListening?.();
		stopListening = undefined;
	});
}

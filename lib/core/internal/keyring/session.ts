/**
 * What an extension keeping credentials in the keyring does with each
 * session: shows the person what the keyring documents say, and moves a
 * plain credentials file left from before into the keyring at once,
 * rather than on the first tool call that reads it.
 *
 * The move runs beside the session's start, never in front of it: a
 * locked keyring may ask the person to unlock it, and pi must stay live
 * while it asks.
 *
 * A session with no screen yet declines a notice rather than showing it
 * nowhere, so it waits, and each turn's start offers it again: pi says
 * nothing as it gives a session a screen, so a turn is the first moment
 * this can see one, and an idle session shows the notice at its next.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	onKeyringNotice,
	retryKeyringNotices,
	sayKeyringNotice,
} from "./notices.ts";
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
		// The session names its one screen for every extension here, by
		// its manager, which pi hands each of them and keeps across a
		// reload; not by ctx.ui, which is pi's one shared stand-in for
		// every session not yet given a screen. Each notice goes to the
		// screen the session has then, since the host may rebind it.
		stopListening = onKeyringNotice((notice) => {
			if (!ctx.hasUI) return false;
			ctx.ui.notify(notice.message, notice.level);
			return true;
		}, ctx.sessionManager);
		move().catch((error: unknown) => {
			sayKeyringNotice({
				level: "warning",
				message: `${label} could not be moved into the keyring: ${reasonOf(error)}. The plain file is kept.`,
			});
		});
	});

	pi.on("turn_start", async () => {
		retryKeyringNotices();
	});

	pi.on("session_shutdown", async () => {
		stopListening?.();
		stopListening = undefined;
	});
}

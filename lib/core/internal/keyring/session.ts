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
 * nowhere, so it waits. pi starts a session again as it binds it a
 * screen, which offers what waits; each turn's start offers it again
 * too, so a screen set without a bind, or one that failed to show it,
 * shows it at the session's next turn.
 * A reload keeps what the session is owed for the extensions it starts
 * again, where they share one copy of the notices rather than each
 * loading its own as pi does today; any other end forgets it. pi makes
 * a new manager for each new, resumed or saved forked session, so the
 * key is one conversation; only forking an unsaved one reuses it, and
 * that fork, ending the session other than by a reload, forgets what it
 * was owed and what it showed.
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
	let stopListening: ReturnType<typeof onKeyringNotice> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		// pi sends the start again each time it binds this runner, as when
		// a session already bound is given a screen, with no shutdown
		// between; a runner's manager is set only as it is made, so this is
		// the same session starting again.
		stopListening?.("back soon");
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

	pi.on("session_shutdown", async (event) => {
		stopListening?.(event.reason === "reload" ? "back soon" : "for good");
		stopListening = undefined;
	});
}

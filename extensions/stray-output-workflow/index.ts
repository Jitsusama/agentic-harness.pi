/**
 * Stray Output extension.
 *
 * Keeps whatever would be written behind pi's screen off it, and says
 * whose it was instead.
 *
 * In interactive mode pi guards neither standard output nor standard
 * error, and its own event bus `console.error`s every `pi.events`
 * handler that throws, stack and all. Each landed over the question
 * bar, wherever the cursor was, was recorded nowhere, and named no
 * writer anybody could read. Now each is kept whole in a log, with the
 * stack that made it, and the person sees one line naming the writer.
 *
 * The guard is installed as this extension loads, so writes during the
 * other extensions' starts are caught too; until a session with a
 * screen starts, and between a reload's two runtimes, they are kept and
 * nothing is said. It acts only while pi's TUI holds the terminal, so a
 * crash report, an external editor, print mode and RPC mode are left
 * alone. See `lib/internal/stray/guard.ts`.
 */

import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stateDir } from "../../lib/internal/paths.ts";
import { homely } from "../../lib/internal/reload/loaded.ts";
import { guardOutput } from "../../lib/internal/stray/guard.ts";
import { strayHandler } from "./notice.ts";

/** Where caught writes are kept. */
const LOG = join(stateDir("stray-output"), "stray.jsonl");

export default function strayOutput(pi: ExtensionAPI): void {
	const keepOnly = () => strayHandler({ log: LOG });
	guardOutput(keepOnly());
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		guardOutput(
			strayHandler({
				log: LOG,
				logName: homely(LOG),
				session: sessionOf(ctx),
				notify: (text) => ctx.ui.notify(text, "warning"),
			}),
		);
	});
	pi.on("session_shutdown", () => guardOutput(keepOnly()));
}

function sessionOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		// A context the session already replaced: the writes are kept
		// without a session rather than not at all.
		return undefined;
	}
}

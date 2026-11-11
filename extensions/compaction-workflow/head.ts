/**
 * Keeps the head a session sent at the front of each request, so a
 * compaction doesn't make the provider write the prompt and tools
 * again, until the patch after it outgrows a quarter of it; see
 * `lib/internal/session/first-head.ts`.
 * `PI_COMPACTION_KEEP_HEAD=off` leaves pi's own head in place.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keepHead } from "../../lib/internal/session/first-head.ts";
import { keptHeadAt } from "../../lib/internal/session/kept-head.ts";

/** The variable that turns keeping the first head off. */
export const KEEP_HEAD_ENV = "PI_COMPACTION_KEEP_HEAD";

/** Put the session's kept head back ahead of every request that lost it. */
export function registerFirstHead(pi: ExtensionAPI): void {
	pi.on("context_with_system", async (event, ctx) => {
		if (process.env[KEEP_HEAD_ENV] === "off") return undefined;
		// Told from what the branch gained since the last request, since
		// walking all of it before each request held pi's main thread.
		const kept = keptHeadAt(ctx.sessionManager);
		if (kept === undefined) return undefined;
		const messages = keepHead(kept, event.messages);
		return messages === undefined ? undefined : { messages };
	});
}

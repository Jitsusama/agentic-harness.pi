/**
 * Keeps the head a session first sent at the front of each request, so
 * a compaction doesn't make the provider write the prompt and tools
 * again; see `lib/internal/session/first-head.ts`.
 * `PI_COMPACTION_KEEP_HEAD=off` leaves pi's own head in place.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	firstHeadOf,
	keepFirstHead,
} from "../../lib/internal/session/first-head.ts";

/** The variable that turns keeping the first head off. */
export const KEEP_HEAD_ENV = "PI_COMPACTION_KEEP_HEAD";

/** Put the session's first head back ahead of every request that lost it. */
export function registerFirstHead(pi: ExtensionAPI): void {
	pi.on("context_with_system", async (event, ctx) => {
		if (process.env[KEEP_HEAD_ENV] === "off") return undefined;
		const first = firstHeadOf(ctx.sessionManager.getBranch());
		if (first === undefined) return undefined;
		const messages = keepFirstHead(first, event.messages);
		return messages === undefined ? undefined : { messages };
	});
}

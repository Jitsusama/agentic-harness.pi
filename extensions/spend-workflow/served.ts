/**
 * Records who served this session's model requests, whenever that changes,
 * as a custom entry the model never reads, so the ledger can tell a cache
 * dropped by a failover to another account from one a provider evicted
 * (lib/internal/session/served.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type SessionRef, sessionSlot } from "../../lib/core/session/index.ts";
import {
	SERVED_ENTRY,
	type Served,
	sameServer,
	saysWho,
	servedBy,
} from "../../lib/internal/session/served.ts";

/** Hear each response's headers and record who served it, on a change. */
export function recordWhoServed(pi: ExtensionAPI): void {
	const state = (ref: SessionRef) =>
		sessionSlot<{ last?: Served }>(
			"agentic-harness.spend.served",
			ref,
			() => ({}),
		);
	pi.on("after_provider_response", (event, ctx) => {
		const served = servedBy(event.headers);
		if (!saysWho(served) || sameServer(state(ctx).last, served)) return;
		try {
			pi.appendEntry(SERVED_ENTRY, served);
			state(ctx).last = served;
		} catch {
			// A session that can't record now retries at the next response; the
			// ledger reads its turns as served by whoever was said last.
		}
	});
	// A new session's log starts without one, so its first response records.
	pi.on("session_start", (_event, ctx) => {
		delete state(ctx).last;
	});
}

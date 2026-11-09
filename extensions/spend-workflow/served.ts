/**
 * Records who served this session's model requests, whenever that changes,
 * as a custom entry the model never reads, so the ledger can tell a cache
 * dropped by a failover to another account from one a provider evicted
 * (lib/internal/session/served.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	SERVED_ENTRY,
	type Served,
	sameServer,
	saysWho,
	servedBy,
} from "../../lib/internal/session/served.ts";

/** Hear each response's headers and record who served it, on a change. */
export function recordWhoServed(pi: ExtensionAPI): void {
	let last: Served | undefined;
	pi.on("after_provider_response", (event) => {
		const served = servedBy(event.headers);
		if (!saysWho(served) || sameServer(last, served)) return;
		last = served;
		try {
			pi.appendEntry(SERVED_ENTRY, served);
		} catch {
			// A session that can't record now records at the next change; the
			// ledger reads its turns as served by whoever was said last.
		}
	});
	// A new session's log starts without one, so its first response records.
	pi.on("session_start", () => {
		last = undefined;
	});
}

/**
 * Park Workflow: ends a session left idle, so it holds no memory while
 * it waits, for its holder to start it again when something needs it.
 *
 * Off unless the switch or `PI_PARK` turns it on, and only for a session
 * a holder keeps (`MYCELIUM_HELD`), since a parked pi with nobody to wake
 * it has simply ended. See lib/internal/session/park.ts for the contract
 * with the holder and the mesh.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearAwake } from "../../lib/internal/session/park.ts";
import { mayPark, noteNeverParks, type Watch, watch } from "./watch.ts";

export default function parkWorkflow(pi: ExtensionAPI) {
	let watching: Watch | undefined;
	// A session that may never park, which said why, to clear as it ends.
	let neverParks: string | undefined;
	const stirred = () => watching?.stirred();
	const unnote = () => {
		if (neverParks) clearAwake(neverParks);
		neverParks = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		watching?.stop();
		unnote();
		watching = mayPark(ctx) ? watch(ctx, pi.events) : undefined;
		if (!watching && noteNeverParks(ctx)) {
			neverParks = ctx.sessionManager.getSessionId();
		}
	});
	pi.on("input", async () => {
		stirred();
		return undefined;
	});
	pi.on("agent_start", async () => stirred());
	pi.on("agent_end", async () => stirred());
	pi.on("ui_prompt_start", async () => watching?.prompting(true));
	pi.on("ui_prompt_end", async () => watching?.prompting(false));
	pi.on("session_shutdown", async () => {
		watching?.stop();
		watching = undefined;
		unnote();
	});
}

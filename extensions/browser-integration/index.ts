/**
 * Browser Integration extension.
 *
 * A family of tools over named, persistent browser sessions,
 * named for what the caller is doing: browser_go to be
 * somewhere and to set the conditions, browser_see to read the
 * page, browser_do to change it, browser_check to form a
 * verdict about it. Elements are named the way they read in the
 * accessibility outline, so the same vocabulary works for
 * seeing and for acting.
 *
 * Sessions dispose after a stretch with no activity and again
 * at shutdown, on the hardened shared browser lifecycle, so
 * nothing leaks and nothing is closed mid-call. The tools load
 * the browser engine on their first call (sessions.ts), so a
 * start that never opens a browser does not pay for it.
 *
 * No slash command: the agent (or a subagent) drives the tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCheck } from "./check-tool.ts";
import { registerDo } from "./do-tool.ts";
import { registerGo } from "./go-tool.ts";
import { registerSee } from "./see-tool.ts";
import { lazySessions } from "./sessions.ts";

export default function browserIntegration(pi: ExtensionAPI) {
	const { sessions, disposeAll } = lazySessions();

	pi.on("session_shutdown", async () => {
		await disposeAll();
	});

	registerGo(pi, sessions);
	registerSee(pi, sessions);
	registerDo(pi, sessions);
	registerCheck(pi, sessions);
}

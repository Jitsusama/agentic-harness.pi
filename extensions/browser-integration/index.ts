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
import {
	ambientSession,
	hosted,
	sessionKeyOf,
} from "../../lib/core/session/index.ts";
import { registerCheck } from "./check-tool.ts";
import { registerDo } from "./do-tool.ts";
import { registerGo } from "./go-tool.ts";
import type { RegistryOptions } from "./registry.ts";
import { registerSee } from "./see-tool.ts";
import { lazySessions } from "./sessions.ts";

/** Register browser tools with a registry owned by this extension instance. */
export default function browserIntegration(pi: ExtensionAPI) {
	// Capture ownership at load, not in browser mechanics or a later callback.
	// A hosted runner owns its contexts, never the Chrome its peers share.
	const options: Pick<RegistryOptions, "ownsBrowser" | "artifactRef"> = {
		ownsBrowser: hosted() === undefined,
		artifactRef: ambientSession(),
	};
	const { sessions, disposeAll } = lazySessions(options);
	pi.on("session_start", async (_event, ctx) => {
		options.artifactRef = sessionKeyOf(ctx);
	});

	pi.on("session_shutdown", async () => {
		await disposeAll();
	});

	registerGo(pi, sessions);
	registerSee(pi, sessions);
	registerDo(pi, sessions);
	registerCheck(pi, sessions);
}

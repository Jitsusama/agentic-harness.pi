/**
 * One Writer Workflow: a plain pi refuses a conversation a live host
 * holds, so no log ever has two writers.
 *
 * At each session start in plain pi, the conversation is looked up in
 * the lists the machine's hosts keep (lib/internal/session/one-writer.ts).
 * Held by one still running, the pi says which host holds it, takes no
 * prompt, and ends with HELD_ELSEWHERE_EXIT. A hosted conversation is
 * its host's own, and a session with no log has none to share, so
 * neither is looked up.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hosted } from "../../lib/core/session/host.ts";
import {
	HELD_ELSEWHERE_EXIT,
	heldElsewhere,
	type Looking,
	liveHolder,
} from "../../lib/internal/session/one-writer.ts";

/** The extension, looking where `looking` says; the machine's unless a test sets it. */
export function oneWriterWorkflow(looking: Looking = {}) {
	return (pi: ExtensionAPI) => {
		// Set once this pi refused its conversation; nothing is taken after.
		let refused = false;
		pi.on("session_start", async (_event, ctx) => {
			if (hosted() || ctx.sessionManager.getSessionFile() === undefined) return;
			const sessionId = ctx.sessionManager.getSessionId();
			const holder = await liveHolder(sessionId, looking);
			if (!holder) return;
			refused = true;
			refuse(ctx, heldElsewhere(sessionId, holder));
		});
		// A prompt given on the command line, or typed before the end lands.
		pi.on("input", () =>
			refused ? { action: "handled" as const } : undefined,
		);
	};
}

/**
 * End this pi, saying why. In its terminal, pi's own shutdown puts the
 * screen back first and an exit listener sets the code, as a park does;
 * elsewhere pi's shutdown waits for a command or run that must not come,
 * so it exits at once.
 */
function refuse(ctx: ExtensionContext, line: string): void {
	if (ctx.mode === "tui") {
		ctx.ui.notify(line, "error");
		// pi ends a quit with process.exit(0); an exit listener's code wins.
		process.once("exit", () => {
			process.exitCode = HELD_ELSEWHERE_EXIT;
			process.stderr.write(`\r\n${line}\r\n`);
		});
		ctx.shutdown();
		return;
	}
	process.stderr.write(`${line}\n`);
	process.exit(HELD_ELSEWHERE_EXIT);
}

export default oneWriterWorkflow();

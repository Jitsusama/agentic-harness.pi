/**
 * Sandbox File Interceptor Extension
 *
 * Holds pi's own file tools to the strict sandbox's fence, in a session
 * that sets `PI_SANDBOX=strict` (see `lib/internal/sandbox.ts`).
 *
 * The sandbox fences each command an agent runs, but pi's read, grep,
 * find, ls, edit and write run in pi's own process, where Landlock
 * never reaches. A session that reads what a stranger wrote could still
 * be told to read a token file with them and quote it back, or to write
 * code where the person's shell runs it later; a council's reviewers,
 * which run no commands at all, have only these tools. Each call is
 * checked before it runs, through every link in its path, against what a
 * fenced command could do there, and refused with the reason when it
 * reaches further. A session with no sandbox is let through untouched.
 *
 * It blocks rather than asks, and goes through no guard policy, since a
 * fence that a policy could soften is one an injected instruction could
 * talk its way past.
 *
 * The skills pi offers the session stay readable, since pi names each
 * skill's file and leaves the model to read it; refusing them would
 * leave a reviewer without the contract its answer is written to.
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileToolRefusal } from "../../lib/internal/sandbox-files.ts";

/** Wires the fence onto each call to pi's file tools. */
export default function sandboxFileInterceptor(pi: ExtensionAPI) {
	let skills: readonly string[] = [];
	pi.on("before_agent_start", async (event) => {
		skills = (event.systemPromptOptions.skills ?? []).map(
			(skill) => skill.baseDir,
		);
		return undefined;
	});
	pi.on("tool_call", async (event, ctx) => {
		const reason = fileToolRefusal(event, {
			cwd: ctx.cwd,
			env: process.env,
			home: homedir(),
			skills,
		});
		if (reason) return { block: true, reason };
		return undefined;
	});
}

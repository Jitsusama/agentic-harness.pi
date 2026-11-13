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
 * Each refusal leaves a line in the system's log under `pi-fence`
 * (`lib/internal/fence-log.ts`): the tool, the sandbox and the session,
 * never the path, so a reader outside the session sees an agent probing
 * the fence. When the log doesn't take it, the refusal says so.
 *
 * The skills pi offers the session stay readable, since pi names each
 * skill's file and leaves the model to read it; refusing them would
 * leave a reviewer without the contract its answer is written to.
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionKeyOf } from "../../lib/core/session/identity.ts";
import { recordRefusal, systemLogger } from "../../lib/internal/fence-log.ts";
import { SANDBOX_VARIABLE } from "../../lib/internal/sandbox.ts";
import { fileToolRefusal } from "../../lib/internal/sandbox-files.ts";
import { offeredShellEnvironment } from "../../lib/internal/shell/environment.ts";

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
			// The loaded quest's TMPDIR reaches only the agent's commands,
			// offered as each starts; judged by pi's own, the quest's scratch
			// would read as another quest's, and the write tool refuse it.
			env: { ...process.env, ...offeredShellEnvironment() },
			home: homedir(),
			skills,
		});
		if (!reason) return undefined;
		const unrecorded = await recordRefusal(
			{
				kind: "path",
				tool: event.toolName,
				sandbox: process.env[SANDBOX_VARIABLE],
				session: sessionKeyOf(ctx),
			},
			systemLogger(),
		);
		return {
			block: true,
			reason: unrecorded ? `${reason} ${unrecorded}` : reason,
		};
	});
}

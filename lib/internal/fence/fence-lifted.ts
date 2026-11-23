/**
 * The agent fence lifted from every session but a fleet's subagents,
 * until it relands with what work needs. From 22:12 to 23:00 on 13
 * November every session was fenced by default (#1520), and the default
 * wrote `PI_SANDBOX=fence` into each pi's own environment, which a
 * reload keeps and a session's record carries into a restart. So the
 * revert (#1523) unfenced no running session: clipboard, git in
 * worktrees, gh and the GPU stayed broken where Joel works.
 *
 * A subagent keeps the fence it was started with, as before 12
 * November, and so does a spawn whose fence was declared, which its
 * spawner marks (`DECLARED_VARIABLE`), since its claim to the node must
 * be what runs (ISXEG8 [8d401568]), on Linux, where pi's own fence
 * runs, and on a Mac where pi runs inside a sandbox, whose commands
 * run inside it as they are. On a Mac with nothing around pi, a declared fence's
 * commands would be refused, so it is lifted with its mark there. Where
 * the trial couldn't tell, as a busy Mac may cause, the fence is kept: its commands are
 * refused until a later trial tells, rather than the host told none.
 * `strict` is never touched. The first stage's default
 * is worked out apart from this (fence-stage.ts), so a lifted value
 * never stops a listed session being fenced.
 */

import { type MacSandbox, macSandbox } from "../sandbox/mac-sandbox.ts";
import { SANDBOX_VARIABLE } from "../sandbox/sandbox.ts";
import { FENCE } from "./fence.ts";
import { isSubagent } from "./fence-stage.ts";

/**
 * Set beside `PI_SANDBOX=fence` by a spawn that declared the fence, so
 * the spawned pi keeps it. Only beside the fence: strict is never lifted,
 * and an older pi that knows no mark lifts the fence as it always has.
 */
export const DECLARED_VARIABLE = "PI_FENCE_DECLARED";

/** The value the mark is set to. */
const DECLARED = "1";

/**
 * The variables a spawn gives a fresh child for the sandbox it declared:
 * `PI_SANDBOX`, and beside the fence the mark that keeps it from the lift.
 */
export function declaredSandbox(
	sandbox: string | undefined,
): Readonly<Record<string, string>> {
	if (sandbox === undefined) return {};
	return sandbox === FENCE
		? { [SANDBOX_VARIABLE]: sandbox, [DECLARED_VARIABLE]: DECLARED }
		: { [SANDBOX_VARIABLE]: sandbox };
}

/**
 * Take `PI_SANDBOX=fence` out of `env` itself, so every reader in this
 * pi and every child it starts sees none, unless this pi is a subagent
 * or a spawn that declared it, on Linux or inside a Mac's sandbox.
 * Answers whether it did.
 */
export function liftFence(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	inside: () => MacSandbox = macSandbox,
): boolean {
	if (env[SANDBOX_VARIABLE]?.trim() !== FENCE || isSubagent(env)) return false;
	const declared =
		env[DECLARED_VARIABLE] === DECLARED &&
		(platform === "linux" || (platform === "darwin" && inside() !== "outside"));
	if (declared) return false;
	delete env[SANDBOX_VARIABLE];
	delete env[DECLARED_VARIABLE];
	return true;
}

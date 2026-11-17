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
 * November, and `strict` is never touched. The first stage's default
 * is worked out apart from this (fence-stage.ts), so a lifted value
 * never stops a listed session being fenced.
 */

import { SANDBOX_VARIABLE } from "../sandbox/sandbox.ts";
import { FENCE } from "./fence.ts";
import { isSubagent } from "./fence-stage.ts";

/**
 * Take `PI_SANDBOX=fence` out of `env` itself, so every reader in this
 * pi and every child it starts sees none, unless this pi is a subagent.
 * Answers whether it did.
 */
export function liftFence(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env[SANDBOX_VARIABLE]?.trim() !== FENCE || isSubagent(env)) {
		return false;
	}
	delete env[SANDBOX_VARIABLE];
	return true;
}

/**
 * What a spawned session runs and what the spawn says of it: the
 * command, resumed or fresh, the model it carries over from the
 * session asking, and the words on what was resumed.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { pickResumeSession } from "../../../lib/internal/quest/reopening/reopen.ts";
import {
	formatRelativeAge,
	type SessionView,
} from "../../../lib/internal/quest/sessions/session-liveness.ts";

/**
 * Decide the command the spawned terminal runs. An explicit command
 * wins outright. Otherwise, when exactly one resumable session was
 * picked, resume it with `pi --session <id>`; with no resumable
 * session (none or several), start a fresh `pi`.
 */
export function resolveSpawnCommand(
	explicitCommand: string | undefined,
	resume: ReturnType<typeof pickResumeSession>,
): { command: string; resumedSessionId?: string } {
	if (explicitCommand?.trim()) return { command: explicitCommand.trim() };
	if (resume && "id" in resume) {
		return {
			command: `pi --session ${resume.id}`,
			resumedSessionId: resume.id,
		};
	}
	return { command: "pi" };
}

/**
 * The model a session runs on, as `pi --model` takes it: provider, id
 * and thinking level, as `anthropic/claude-opus-5-5:high`. Undefined
 * when the session has no model yet.
 */
export function modelOf(
	ctx: Pick<ExtensionContext, "model" | "thinkingLevel">,
): string | undefined {
	const { model, thinkingLevel } = ctx;
	if (!model) return undefined;
	const named = `${model.provider}/${model.id}`;
	return thinkingLevel ? `${named}:${thinkingLevel}` : named;
}

/**
 * The command a spawn runs with the model of the session asking for it,
 * so the new one runs on the same model rather than on whatever pi's
 * default says: on 9 November a launcher pi is wrapped in changed that
 * default, and every session spawned after ran on another model. A
 * command already naming a model keeps its own.
 */
export function carryingModel(
	command: string,
	model: string | undefined,
): string {
	if (!model || /(^| )--model( |=)/.test(command)) return command;
	return `${command} --model ${model}`;
}

/**
 * The resume fragment appended to the spawn message. A live resume
 * reads plainly; an idle resume is flagged as such and carries its
 * last-active age so a day-old session is not silently presented as
 * current. Several live sessions report the count; nothing
 * resumable yields no fragment.
 */
export function resumeMessage(
	resume: ReturnType<typeof pickResumeSession>,
	sessions: SessionView[],
	now: Date,
): string | undefined {
	if (resume && "id" in resume) {
		const picked = sessions.find((s) => s.id === resume.id);
		if (picked?.liveness === "idle") {
			const age = formatRelativeAge(picked.lastActivity, now);
			return `Resuming idle session ${resume.id}${age ? `, last active ${age}` : ""}.`;
		}
		return `Resuming session ${resume.id}.`;
	}
	if (resume && "ambiguous" in resume) {
		return `${resume.ambiguous.length} live sessions; started fresh, resume one explicitly if needed.`;
	}
	return undefined;
}

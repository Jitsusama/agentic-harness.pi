/**
 * Shared helpers for quest-workflow tests: a defensive
 * env-isolation guard, two that narrow a result, and one
 * that reads a quest's Journey.
 *
 * The workflow no longer reads `QUEST_WORKFLOW_ROOT` (the
 * quests root comes from the package config, and tests pass
 * an explicit root to `createQuestState`), so that guard now
 * only scrubs a deprecated variable a developer might still
 * have in their shell, keeping the environment clean across
 * runs.
 */

import { readFileSync } from "node:fs";
import type { QuestResult } from "../../../extensions/quest-workflow/verbs/shared";
import { questJourneyLines } from "../../../lib/internal/quest/journey";

/**
 * A quest's whole Journey as text, newest first: whatever its
 * README's section still holds, then its Journey file.
 */
export function journeyOf(questDir: string): string {
	const readme = readFileSync(`${questDir}/README.md`, "utf8");
	return questJourneyLines(questDir, readme).join("\n");
}

const VAR = "QUEST_WORKFLOW_ROOT";

interface EnvGuard {
	enter(): void;
	leave(): void;
}

/**
 * The success half of a result, or a failure naming the
 * refusal.
 *
 * `QuestResult` is a union on `ok`, so reading `details` off
 * one that has not been narrowed does not typecheck. Tests
 * were writing `expect(result.ok).toBe(true)` and then
 * reaching for `details` anyway, which reads as though the
 * assertion narrowed it and does not.
 *
 * Worth a helper rather than an `if` at each site for what it
 * says when it fails. A refusal reached through a cast gives
 * `undefined`, then a property access on undefined several
 * lines later, and the guidance explaining the refusal is
 * never printed. This prints it.
 */
export function succeeded(
	result: QuestResult,
): Extract<QuestResult, { ok: true }> {
	if (!result.ok)
		throw new Error(`expected success, refused: ${result.guidance}`);
	return result;
}

/** The refusal half, or a failure naming what happened instead. */
export function refused(
	result: QuestResult,
): Extract<QuestResult, { ok: false }> {
	if (result.ok) throw new Error(`expected a refusal, got: ${result.message}`);
	return result;
}

export function createEnvGuard(): EnvGuard {
	let saved: string | undefined;
	return {
		enter() {
			saved = process.env[VAR];
			delete process.env[VAR];
		},
		leave() {
			if (saved !== undefined) process.env[VAR] = saved;
			else delete process.env[VAR];
		},
	};
}

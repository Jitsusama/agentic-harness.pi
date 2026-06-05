/**
 * Shared helpers for quest-workflow tests: a defensive
 * env-isolation guard. The workflow no longer reads
 * `QUEST_WORKFLOW_ROOT` (the quests root comes from the
 * package config, and tests pass an explicit root to
 * `createQuestState`), so this guard now only scrubs a
 * deprecated variable that a developer might still have in
 * their shell, keeping the environment clean across runs.
 */

const VAR = "QUEST_WORKFLOW_ROOT";

interface EnvGuard {
	enter(): void;
	leave(): void;
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

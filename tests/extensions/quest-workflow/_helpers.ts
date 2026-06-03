/**
 * Shared helpers for quest-workflow tests. Currently just
 * an env-isolation guard: the workflow reads
 * `QUEST_WORKFLOW_ROOT` from the process env to override
 * the default questsRoot, so a developer who has it set in
 * their shell would otherwise see every test creating
 * quests inside their real registry. Each test file wraps
 * its beforeEach/afterEach in this helper to scrub the
 * variable and restore it afterwards.
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

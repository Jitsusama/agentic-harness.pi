/**
 * What every test of the quest verbs runs in: a fresh quests root under
 * a temporary folder, the built-in reference types and no URL fetcher or
 * terminal driver, each put back after the test. Importing this sets
 * that up around every test in the file.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import { leaveSpawns } from "../../../../lib/internal/fence-stage.ts";
import { clearUrlFetchers } from "../../../../lib/quest/index.ts";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../../lib/refs/index.ts";
import { clearTerminalDrivers } from "../../../../lib/terminal/index.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { createEnvGuard } from "../_helpers.ts";

/** The test's temporary folder, made fresh before each test. */
export const fixture = { root: "" };

/** A quest state over the test's own quests root. */
export function buildState() {
	return createQuestState({ questsRoot: join(fixture.root, "quests") });
}

const envGuard = createEnvGuard();

beforeEach(() => {
	envGuard.enter();
	fixture.root = mkdtempSync(join(tmpdir(), "quest-verbs-"));
	clearRefTypes();
	registerBuiltinRefTypes();
	clearUrlFetchers();
	clearTerminalDrivers();
});

afterEach(() => {
	leaveSpawns();
	rmSync(fixture.root, { recursive: true, force: true });
	clearRefTypes();
	clearUrlFetchers();
	clearTerminalDrivers();
	envGuard.leave();
});

/** Create a quest through the verbs, handing back its id and README path. */
export async function createQuest(
	state: ReturnType<typeof buildState>,
	title: string,
) {
	// Created with no session of its own, so a fixture quest has no
	// session cwd to steer the verbs under test.
	const result = await handle(
		state,
		fakePi(),
		{
			cwd: fixture.root,
			sessionManager: {
				getSessionId: () => undefined,
				isPersisted: () => false,
			},
		} as unknown as Parameters<typeof handle>[2],
		{ action: "create", title },
	);
	if (!result.ok) throw new Error(result.guidance);
	return result.details as { id: string; path: string };
}

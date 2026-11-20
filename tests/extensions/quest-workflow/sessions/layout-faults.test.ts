import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { BudgetKeeper } from "../../../../extensions/quest-workflow/budget.ts";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { followSessionLife } from "../../../../extensions/quest-workflow/wiring/session.ts";
import { withFileLock } from "../../../../lib/core/internal/file-lock.ts";
import { withSession } from "../../../../lib/core/session/index.ts";
import { clearDiscoveryCache } from "../../../../lib/internal/quest/discovery/discovery.ts";
import { layoutFaultsFile } from "../../../../lib/internal/quest/discovery/layout-faults.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { createEnvGuard } from "../_helpers.ts";

const envGuard = createEnvGuard();
let tmpRoot: string;

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "layout-faults-start-"));
	clearDiscoveryCache();
	rmSync(layoutFaultsFile(), { force: true });
});

afterEach(() => {
	clearDiscoveryCache();
	rmSync(layoutFaultsFile(), { force: true });
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

/** A session's context at its start in `cwd`, with a screen that records. */
function startIn(cwd: string, notices: string[]): unknown {
	return {
		cwd,
		hasUI: true,
		isIdle: () => true,
		ui: new Proxy(
			{},
			{
				get: (_target, name) =>
					name === "notify"
						? (text: unknown) => notices.push(String(text))
						: () => undefined,
			},
		),
		sessionManager: {
			getSessionId: () => "a",
			isPersisted: () => false,
			getEntries: () => [],
			getBranch: () => [],
		},
	};
}

/** The record's lines on disk, or none when it was never written. */
function recordedLines(): string[] {
	const file = layoutFaultsFile();
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "");
}

it("keeps a quest folder with no README to the record, once, and off the screen", async () => {
	const questsRoot = join(tmpRoot, "quests");
	mkdirSync(join(questsRoot, "QEST-20261120-AAAAAA"), { recursive: true });
	const notices: string[] = [];
	const budgets = { keep: async () => undefined, forget: () => undefined };

	for (const reason of ["startup", "reload"]) {
		const pi = fakePi();
		const state = createQuestState({ questsRoot });
		followSessionLife(pi, state, budgets as unknown as BudgetKeeper, undefined);
		const [start] = pi.recorded.handlers.get("session_start") ?? [];
		clearDiscoveryCache();
		await withSession("a", async () =>
			start?.({ type: "session_start", reason }, startIn(tmpRoot, notices)),
		);
		// The start writes without waiting; a turn at the record's lock in
		// this process comes after that write has finished.
		await withFileLock(layoutFaultsFile(), async () => undefined);
		expect(recordedLines(), `the record after the ${reason}`).toHaveLength(1);
	}

	expect(notices, "what the starts showed").toEqual([]);
	const [line] = recordedLines();
	expect(JSON.parse(line ?? "{}"), "the recorded fault").toMatchObject({
		path: expect.stringContaining("QEST-20261120-AAAAAA"),
		message: "README.md missing",
	});
});

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BudgetKeeper } from "../../../../extensions/quest-workflow/budget.ts";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { followSessionLife } from "../../../../extensions/quest-workflow/wiring/session.ts";
import { withSession } from "../../../../lib/core/session/index.ts";
import { clearDiscoveryCache } from "../../../../lib/internal/quest/discovery/discovery.ts";
import {
	layoutFaultsFile,
	readLayoutFaults,
} from "../../../../lib/internal/quest/discovery/layout-faults.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { createEnvGuard } from "../_helpers.ts";

/** What went to the system's journal, each write with the level it was at. */
const journalled = vi.hoisted(
	() => [] as { text: string; level: string | undefined }[],
);
vi.mock("../../../../lib/internal/session/journal.ts", async (original) => ({
	...(await original<object>()),
	journalCommand: (level: string) => ({ program: "journal", args: [level] }),
	sayInJournal: (text: string, command: { args: string[] } | undefined) =>
		journalled.push({ text, level: command?.args[0] }),
}));

const envGuard = createEnvGuard();
let tmpRoot: string;

beforeEach(() => {
	envGuard.enter();
	journalled.length = 0;
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

/** The record's faults' paths on disk, or none when it was never written. */
function recordedPaths(): string[] {
	const reading = readLayoutFaults();
	return reading.kind === "read"
		? reading.record.faults.map((fault) => fault.path)
		: [];
}

it("keeps a quest folder with no README to the record and the journal, once, and off the screen", async () => {
	const questsRoot = join(tmpRoot, "quests");
	const notices: string[] = [];
	const budgets = { keep: async () => undefined, forget: () => undefined };

	for (const [reason, folder] of [
		["startup", "QEST-20261120-AAAAAA"],
		["reload", "QEST-20261120-BBBBBB"],
	]) {
		mkdirSync(join(questsRoot, folder ?? ""), { recursive: true });
		const pi = fakePi();
		const state = createQuestState({ questsRoot });
		followSessionLife(pi, state, budgets as unknown as BudgetKeeper, undefined);
		const [start] = pi.recorded.handlers.get("session_start") ?? [];
		clearDiscoveryCache();
		await withSession("a", async () =>
			start?.({ type: "session_start", reason }, startIn(tmpRoot, notices)),
		);
		// The start keeps the faults without waiting, and journals after
		// the record is written, so the test waits for the journal.
		await vi.waitFor(() =>
			expect(
				journalled.map((write) => write.text).join("\n"),
				`the journal after the ${reason}`,
			).toContain(folder ?? ""),
		);
	}

	expect(notices, "what the starts showed").toEqual([]);
	// In the walk's order, which is the folder listing's, so sorted here.
	expect(recordedPaths().sort(), "the faults the reload found").toEqual([
		expect.stringContaining("QEST-20261120-AAAAAA"),
		expect.stringContaining("QEST-20261120-BBBBBB"),
	]);
	expect(journalled, "each fault journalled once, as first found").toEqual([
		{
			text: expect.stringMatching(/QEST-20261120-AAAAAA.*README\.md missing/),
			level: "warning",
		},
		{
			text: expect.stringMatching(/QEST-20261120-BBBBBB.*README\.md missing/),
			level: "warning",
		},
	]);
});

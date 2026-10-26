/**
 * A dry run is honoured or refused, never dropped.
 *
 * A caller passing `dryRun: true` is counting on nothing being written.
 * The dispatcher used to hand every verb the whole params, so a verb
 * that never read `dryRun` acted for real: on 23 October a `section`
 * given one replaced a plan's whole Work section, and an `undo` given
 * one reopened a concluded quest and popped its journal entry.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { createEnvGuard, refused, succeeded } from "./_helpers";

let root: string;
let savedCache: string | undefined;
const envGuard = createEnvGuard();

function fakePi() {
	return {
		setSessionName: () => {},
		appendEntry: () => {},
	} as unknown as Parameters<typeof handle>[1];
}

function fakeCtx() {
	return {
		cwd: root,
		sessionManager: {
			getSessionId: () => "sess-1",
			isPersisted: () => false,
			getEntries: () => [],
		},
	} as unknown as Parameters<typeof handle>[2];
}

beforeEach(() => {
	envGuard.enter();
	root = mkdtempSync(join(tmpdir(), "dry-run-"));
	savedCache = process.env.XDG_CACHE_HOME;
	process.env.XDG_CACHE_HOME = join(root, "cache");
});

afterEach(() => {
	if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = savedCache;
	rmSync(root, { recursive: true, force: true });
	envGuard.leave();
});

const questsRoot = () => join(root, "quests");
const journalPath = () => join(questsRoot(), ".structural-journal.jsonl");

const readmeOf = (id: string) => join(questsRoot(), id, "README.md");
const read = (path: string) =>
	existsSync(path) ? readFileSync(path, "utf8") : "";

/**
 * A loaded quest with a plan in build and focused, plus a second quest
 * concluded by the sweep, so the structural journal has an entry undo
 * would reverse.
 */
async function world() {
	const state = createQuestState({ questsRoot: questsRoot() });
	const run = (params: Parameters<typeof handle>[3]) =>
		handle(state, fakePi(), fakeCtx(), params);
	const other = succeeded(await run({ action: "create", title: "Done Quest" }));
	const otherId = String(other.details?.id);
	succeeded(await run({ action: "unload" }));
	succeeded(await run({ action: "conclude", id: otherId }));

	const loaded = succeeded(
		await run({ action: "create", title: "Live Quest" }),
	);
	const questId = String(loaded.details?.id);
	if (state.questId !== questId) {
		succeeded(await run({ action: "load", id: questId }));
	}
	succeeded(await run({ action: "think", kind: "plan", note: "dry runs" }));
	succeeded(await run({ action: "draft", title: "Dry Plan" }));
	const planPath = state.documentPath ?? "";
	const planId = String(state.documentId);
	const text = readFileSync(planPath, "utf8");
	const head = text.slice(0, text.indexOf("\n---\n") + 5);
	writeFileSync(
		planPath,
		`${head}# Dry Plan\n\n## Work\n\n- [ ] First item\n- [ ] Second item\n\n## Notes\n\nOld notes.\n`,
	);
	succeeded(await run({ action: "build" }));

	/** Every file a dry run must leave as it was. */
	const snapshot = () => ({
		plan: read(planPath),
		quest: read(readmeOf(questId)),
		other: read(readmeOf(otherId)),
		journal: read(journalPath()),
	});
	return { state, run, questId, otherId, planId, planPath, snapshot };
}

describe("an action that cannot honour a dry run", () => {
	it("refuses section rather than replacing the section", async () => {
		const { run, snapshot } = await world();
		const before = snapshot();

		const result = refused(
			await run({
				action: "section",
				title: "Work",
				body: "PLACEHOLDER",
				dryRun: true,
			}),
		);

		expect(result.guidance).toContain("section");
		expect(result.guidance).toContain("dryRun");
		expect(snapshot()).toEqual(before);
	});

	it("refuses undo rather than reversing the last change", async () => {
		const { run, otherId, snapshot } = await world();
		const before = snapshot();
		expect(before.other).toContain("status: concluded");

		const result = refused(await run({ action: "undo", dryRun: true }));

		// It says what undo would put back, which is what the caller wanted.
		expect(result.guidance).toContain("conclude");
		expect(result.guidance).toContain("1 quest");
		expect(result.guidance).toContain(otherId);
		expect(result.guidance).toContain("status concluded back to active");
		expect(snapshot()).toEqual(before);
		expect(read(readmeOf(otherId))).toContain("status: concluded");
	});

	it.each([
		{ action: "journal", note: "a line" },
		{ action: "tick", query: "first" },
		{ action: "untick", query: "first" },
		{ action: "think", kind: "plan", note: "another" },
		{ action: "unfocus" },
		{ action: "alias-add", ref: "github-pr:a/b#1" },
		{ action: "park" },
	])("refuses $action and writes nothing", async (params) => {
		const { run, snapshot } = await world();
		const before = snapshot();

		refused(
			await run({ ...params, dryRun: true } as Parameters<typeof handle>[3]),
		);

		expect(snapshot()).toEqual(before);
	});

	it("refuses to conclude the loaded quest, which would seal it", async () => {
		const { run, questId, snapshot } = await world();
		const before = snapshot();

		const result = refused(
			await run({ action: "conclude", id: questId, dryRun: true }),
		);

		expect(result.guidance).toContain("dryRun");
		expect(snapshot()).toEqual(before);
	});

	it("refuses to conclude a document, named or focused", async () => {
		const { run, planId, snapshot } = await world();
		const before = snapshot();

		refused(await run({ action: "conclude", id: planId, dryRun: true }));
		refused(await run({ action: "retire", reason: "no", dryRun: true }));

		expect(snapshot()).toEqual(before);
	});

	it("goes ahead when dryRun is false, as when it is left out", async () => {
		const { run, planPath } = await world();

		succeeded(await run({ action: "tick", query: "first", dryRun: false }));

		expect(read(planPath)).toContain("- [x] First item");
	});
});

describe("an undo given an id", () => {
	// undo reverses the journal's last entry, whatever it is named. On 24
	// October an undo given a plan's id, meant for a section write that
	// undo cannot reverse, reopened another session's concluded quest.
	it("refuses an id the last change did not touch, saying what it would undo", async () => {
		const { run, planId, questId, otherId, snapshot } = await world();
		const before = snapshot();

		for (const id of [planId, questId]) {
			const result = refused(await run({ action: "undo", id }));
			expect(result.guidance).toContain(id);
			expect(result.guidance).toContain(otherId);
			expect(result.guidance).toContain("conclude");
			expect(result.guidance).toContain("section");
		}

		expect(snapshot()).toEqual(before);
	});

	// On 25 October an undo with no id, meant for the caller's own section
	// write, reopened twelve quests another session had just concluded.
	it("undoes its own last change with no id, since it can reach no other", async () => {
		const { run, otherId } = await world();

		succeeded(await run({ action: "undo" }));

		expect(read(readmeOf(otherId))).not.toContain("status: concluded");
	});

	it("undoes the last change when the id is one it touched", async () => {
		const { run, otherId } = await world();

		succeeded(await run({ action: "undo", id: otherId }));

		expect(read(readmeOf(otherId))).not.toContain("status: concluded");
	});
});

describe("an action that honours a dry run", () => {
	it("still previews a sweep of quests not loaded here", async () => {
		const { run, state, questId, snapshot } = await world();
		// A session already on a quest stays there when it creates another.
		const spare = succeeded(
			await run({ action: "create", title: "Spare Quest" }),
		);
		const spareId = String(spare.details?.id);
		expect(state.questId).toBe(questId);
		const before = snapshot();
		const spareBefore = read(readmeOf(spareId));

		const result = succeeded(
			await run({ action: "conclude", id: spareId, dryRun: true }),
		);

		expect(result.message).toContain("would conclude 1 quest");
		expect(snapshot()).toEqual(before);
		expect(read(readmeOf(spareId))).toEqual(spareBefore);
	});

	it("still previews a reparent", async () => {
		const { run, questId, otherId, snapshot } = await world();
		const before = snapshot();

		const result = succeeded(
			await run({
				action: "reparent",
				id: questId,
				parent: otherId,
				dryRun: true,
			}),
		);

		expect(result.message).toContain("Dry run");
		expect(snapshot()).toEqual(before);
	});
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { reversibleFields } from "../../../lib/internal/quest/fields";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index";
import { createEnvGuard, succeeded } from "./_helpers";

let tmpRoot: string;
let guard: ReturnType<typeof createEnvGuard>;

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}

function fakeCtx(cwd: string) {
	return {
		cwd,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}

function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

async function createQuest(
	state: ReturnType<typeof buildState>,
	title: string,
) {
	const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "create",
		title,
	});
	if (!result.ok) throw new Error(result.guidance);
	return result.details as { id: string };
}

function readmePath(id: string): string {
	return join(tmpRoot, "quests", id, "README.md");
}

function fieldOf(id: string, key: string): string {
	const text = readFileSync(readmePath(id), "utf8");
	const line = text.split("\n").find((l) => l.startsWith(`${key}:`));
	return (line ?? "").replace(`${key}:`, "").trim();
}

function journalPath(): string {
	return join(tmpRoot, "quests", ".structural-journal.jsonl");
}

/** Rewrite the last journalled change for `field` to a bogus old value. */
function corruptJournalledOld(field: string, bogus: string): void {
	const entries = readFileSync(journalPath(), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	for (const change of entries[entries.length - 1].changes) {
		if (change.field === field) change.old = bogus;
	}
	writeFileSync(
		journalPath(),
		`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);
}

beforeEach(() => {
	guard = createEnvGuard();
	guard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "undo-general-"));
	clearRefTypes();
	registerBuiltinRefTypes();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	guard.leave();
	clearRefTypes();
});

describe("undo over any journalled field", () => {
	it("reverses a kind change, which had its own bespoke setter", () => {
		// `kind` was reversible only because someone remembered to export a
		// setter for it and wire a case into undo's switch. It now works
		// because it has a lens, like every other field.
		expect(reversibleFields()).toContain("kind");
	});

	it("reverses a reclassify end to end", async () => {
		const state = buildState();
		const quest = await createQuest(state, "Reclassify Me");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: quest.id,
		});
		// A quest minted outside a quest tree starts as a sidequest, so
		// promoting it to a full quest is the change that actually moves.
		const before = fieldOf(quest.id, "kind");
		expect(before).toBe("sidequest");

		succeeded(
			await handle(state, fakePi(), fakeCtx(tmpRoot), {
				action: "reclassify",
				kind: "quest",
			}),
		);
		expect(fieldOf(quest.id, "kind")).toBe("quest");

		succeeded(
			await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "undo" }),
		);
		expect(fieldOf(quest.id, "kind")).toBe(before);
	});

	it("refuses a journalled value the vocabulary no longer has", async () => {
		// A journal written by an older build, or edited by hand, can name
		// a word the vocabulary lost. Undo used to cast it straight to the
		// field type and write it, which is how an unreadable quest is made
		// by a tool whose whole job is putting things back.
		//
		// Two layers refuse this now, the lens and the parse-back check on
		// the write itself, and removing either one leaves this test
		// passing. That is the point of it: it pins the outcome, not the
		// layer. The lens tests in tests/lib/internal/quest/fields.test.ts
		// are what pin the lens.
		const state = buildState();
		const quest = await createQuest(state, "Vocabulary Drift");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: quest.id,
		});
		succeeded(
			await handle(state, fakePi(), fakeCtx(tmpRoot), {
				action: "reclassify",
				kind: "quest",
			}),
		);
		corruptJournalledOld("kind", "sleepy");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "undo",
		});

		expect(result.ok).toBe(false);
		expect(fieldOf(quest.id, "kind")).toBe("quest");
	});

	it("leaves the quest readable after refusing", async () => {
		// The refusal is only worth having if the README survives it. A
		// half-written status is the failure this whole strand is about.
		const state = buildState();
		const quest = await createQuest(state, "Still Readable");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: quest.id,
		});
		succeeded(
			await handle(state, fakePi(), fakeCtx(tmpRoot), {
				action: "reclassify",
				kind: "quest",
			}),
		);
		corruptJournalledOld("kind", "sleepy");
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "undo" });

		const listed = succeeded(
			await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "list" }),
		);
		expect(JSON.stringify(listed.details ?? "")).toContain(quest.id);
	});
});

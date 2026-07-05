import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return {
		setSessionName: () => {},
	} as unknown as Parameters<typeof handle>[1];
}

function fakeCtx(cwd: string, sessionId = "sess-1") {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId },
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
	return result.details as { id: string; path: string };
}

function fieldOf(id: string, key: string): string {
	const text = readFileSync(join(tmpRoot, "quests", id, "README.md"), "utf8");
	const line = text.split("\n").find((l) => l.startsWith(`${key}:`));
	return (line ?? "").replace(`${key}:`, "").trim();
}

function parentOf(id: string): string {
	return fieldOf(id, "parent");
}

function statusOf(id: string): string {
	return fieldOf(id, "status");
}

function readReadme(id: string): string {
	return readFileSync(join(tmpRoot, "quests", id, "README.md"), "utf8");
}

// Simulate an out-of-band edit: rewrite the parent frontmatter line
// directly, bypassing the workflow and the journal.
function setParentDirect(id: string, value: string): void {
	const path = join(tmpRoot, "quests", id, "README.md");
	const text = readFileSync(path, "utf8");
	writeFileSync(path, text.replace(/^parent:.*$/m, `parent: ${value}`));
}

const envGuard = createEnvGuard();

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-reparent-"));
	clearRefTypes();
	registerBuiltinRefTypes();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	clearRefTypes();
	envGuard.leave();
});

describe("reparent verb", () => {
	it("moves a quest under a new parent and reports the change", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const child = await createQuest(state, "Child");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: parent.id,
		});
		expect(result.ok).toBe(true);
		expect(parentOf(child.id)).toBe(parent.id);
		const details = result.details as {
			changes: { id: string; newParent: string | null }[];
		};
		expect(details.changes).toEqual([
			{ id: child.id, oldParent: null, newParent: parent.id },
		]);
	});

	it("previews without writing when dryRun is set", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const child = await createQuest(state, "Child");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: parent.id,
			dryRun: true,
		});
		expect(result.ok).toBe(true);
		// Nothing written: the child stays top-level.
		expect(parentOf(child.id)).toBe("null");
		const details = result.details as { dryRun: boolean };
		expect(details.dryRun).toBe(true);
	});

	it("reparents many quests in one call", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const a = await createQuest(state, "A");
		const b = await createQuest(state, "B");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: `${a.id},${b.id}`,
			parent: parent.id,
		});
		expect(result.ok).toBe(true);
		expect(parentOf(a.id)).toBe(parent.id);
		expect(parentOf(b.id)).toBe(parent.id);
	});

	it("refuses the whole batch and writes nothing when any target errors", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const child = await createQuest(state, "Child");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: `${child.id},QEST-20260604-GONE99`,
			parent: parent.id,
		});
		expect(result.ok).toBe(false);
		expect(result.guidance).toMatch(/GONE99/);
		// The valid target was not moved: the batch is atomic.
		expect(parentOf(child.id)).toBe("null");
	});

	it("undo reverses the last reparent, restoring the prior parent", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const child = await createQuest(state, "Child");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: parent.id,
		});
		expect(parentOf(child.id)).toBe(parent.id);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "undo",
		});
		expect(result.ok).toBe(true);
		expect(parentOf(child.id)).toBe("null");
	});

	it("does not journal a dry run, so undo finds nothing", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const child = await createQuest(state, "Child");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: parent.id,
			dryRun: true,
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "undo",
		});
		expect(result.ok).toBe(false);
		expect(result.guidance).toMatch(/nothing to undo/i);
	});

	it("refuses undo when nothing has been done", async () => {
		const state = buildState();
		await createQuest(state, "Solo");
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "undo",
		});
		expect(result.ok).toBe(false);
		expect(result.guidance).toMatch(/nothing to undo/i);
	});

	it("bulk retires a comma-separated set and is undoable", async () => {
		const state = buildState();
		const a = await createQuest(state, "A");
		const b = await createQuest(state, "B");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "retire",
			id: `${a.id},${b.id}`,
			reason: "duplicates",
		});
		expect(result.ok).toBe(true);
		expect(statusOf(a.id)).toBe("retired");
		expect(statusOf(b.id)).toBe("retired");

		const undone = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "undo",
		});
		expect(undone.ok).toBe(true);
		expect(statusOf(a.id)).toBe("active");
		expect(statusOf(b.id)).toBe("active");
	});

	it("a single explicit id targets that quest, not the loaded one", async () => {
		const state = buildState();
		const loaded = await createQuest(state, "Loaded");
		const other = await createQuest(state, "Other");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: loaded.id,
		});

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "conclude",
			id: other.id,
		});
		expect(result.ok).toBe(true);
		// The named quest is concluded; the loaded quest is untouched.
		expect(statusOf(other.id)).toBe("concluded");
		expect(statusOf(loaded.id)).toBe("active");

		// And it is reversible (as is the loaded-quest path now).
		const undone = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "undo",
		});
		expect(undone.ok).toBe(true);
		expect(statusOf(other.id)).toBe("active");
	});

	it("bulk conclude cascades the seal and undo restores the priority", async () => {
		const state = buildState();
		const a = await createQuest(state, "A");
		expect(fieldOf(a.id, "priority")).toBe("active");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "conclude",
			id: a.id,
		});
		expect(result.ok).toBe(true);
		expect(statusOf(a.id)).toBe("concluded");
		expect(fieldOf(a.id, "priority")).toBe("someday");

		const undone = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "undo",
		});
		expect(undone.ok).toBe(true);
		expect(statusOf(a.id)).toBe("active");
		expect(fieldOf(a.id, "priority")).toBe("active");
	});

	it("makes a loaded-quest conclude reversible, restoring status and priority", async () => {
		const state = buildState();
		const a = await createQuest(state, "Loaded Reversible");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "drive" });
		expect(fieldOf(a.id, "priority")).toBe("driving");

		const concluded = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "conclude",
		});
		expect(concluded.ok).toBe(true);
		expect(statusOf(a.id)).toBe("concluded");
		expect(fieldOf(a.id, "priority")).toBe("someday");

		const undone = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "undo",
		});
		expect(undone.ok).toBe(true);
		expect(statusOf(a.id)).toBe("active");
		expect(fieldOf(a.id, "priority")).toBe("driving");
	});

	it("restores the loaded quest's rank on undo, not a someday rank", async () => {
		const state = buildState();
		const first = await createQuest(state, "First Driving");
		const second = await createQuest(state, "Second Driving");
		for (const q of [first, second]) {
			await handle(state, fakePi(), fakeCtx(tmpRoot), {
				action: "load",
				id: q.id,
			});
			await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "drive" });
		}
		// The loaded quest sits at a non-first rank in the driving bucket.
		const rankBefore = fieldOf(second.id, "rank");
		expect(rankBefore).not.toBe("1");

		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: second.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "conclude" });
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "undo" });

		expect(statusOf(second.id)).toBe("active");
		expect(fieldOf(second.id, "priority")).toBe("driving");
		// The rank returns to its pre-conclude value: the seal must not
		// have renumbered it into the someday bucket and stranded it there.
		expect(fieldOf(second.id, "rank")).toBe(rankBefore);
		// And it no longer collides with the sibling that kept rank 1.
		expect(fieldOf(first.id, "rank")).toBe("1");
	});

	it("warns about live children when concluding the loaded parent", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Loaded Parent");
		const child = await createQuest(state, "Loaded Child");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: parent.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: parent.id,
		});

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "conclude",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.message).toContain(child.id);
		expect(statusOf(child.id)).toBe("active");
	});

	it("warns about live children without sealing them", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const child = await createQuest(state, "Child");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: parent.id,
		});

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "conclude",
			id: parent.id,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.message).toContain(child.id);
		// The child is warned about, not sealed.
		expect(statusOf(child.id)).toBe("active");
	});

	it("bulk conclude previews under dryRun without writing", async () => {
		const state = buildState();
		const a = await createQuest(state, "A");
		const b = await createQuest(state, "B");
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "conclude",
			id: `${a.id},${b.id}`,
			dryRun: true,
		});
		expect(result.ok).toBe(true);
		expect(statusOf(a.id)).toBe("active");
		expect(statusOf(b.id)).toBe("active");
	});

	it("bulk retire needs a reason", async () => {
		const state = buildState();
		const a = await createQuest(state, "A");
		const b = await createQuest(state, "B");
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "retire",
			id: `${a.id},${b.id}`,
		});
		expect(result.ok).toBe(false);
		expect(result.guidance).toMatch(/reason/i);
	});

	it("bulk refuses the whole set when a target is missing", async () => {
		const state = buildState();
		const a = await createQuest(state, "A");
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "conclude",
			id: `${a.id},QEST-20260604-GONE99`,
		});
		expect(result.ok).toBe(false);
		expect(result.guidance).toMatch(/GONE99/);
		expect(statusOf(a.id)).toBe("active");
	});

	it("undo skips a quest whose value changed since, rather than clobbering it", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const other = await createQuest(state, "Other");
		const child = await createQuest(state, "Child");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: parent.id,
		});
		expect(parentOf(child.id)).toBe(parent.id);

		// An intervening edit moves the child somewhere the journal did
		// not record. Undo must not stomp it back to null.
		setParentDirect(child.id, other.id);
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "undo",
		});
		expect(result.ok).toBe(true);
		expect(parentOf(child.id)).toBe(other.id);
		const details = result.details as { skipped: string[] };
		expect(details.skipped).toContain(child.id);
	});

	it("keeps a skipped change undoable after the divergence resolves", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const other = await createQuest(state, "Other");
		const a = await createQuest(state, "A");
		const b = await createQuest(state, "B");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: `${a.id},${b.id}`,
			parent: parent.id,
		});

		// Divert A out-of-band so the first undo must skip it while it
		// still reverses B.
		setParentDirect(a.id, other.id);
		const first = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "undo",
		});
		expect(first.ok).toBe(true);
		expect(parentOf(b.id)).toBe("null");
		expect(parentOf(a.id)).toBe(other.id);

		// The divergence resolves: A is back where the journal recorded
		// it. A second undo must still be able to reverse A, because the
		// first undo did not consume the change it could not apply.
		setParentDirect(a.id, parent.id);
		const second = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "undo",
		});
		expect(second.ok).toBe(true);
		expect(parentOf(a.id)).toBe("null");
	});

	it("undo of a bulk conclude leaves a compensating Journey entry", async () => {
		const state = buildState();
		const a = await createQuest(state, "A");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "conclude",
			id: a.id,
		});
		expect(statusOf(a.id)).toBe("concluded");
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "undo" });
		expect(statusOf(a.id)).toBe("active");
		// The original "Concluded the quest (bulk)." entry must not stand
		// uncontradicted on a quest that now reads active.
		expect(readReadme(a.id)).toMatch(/Reverted the conclude \(undo\)\./);
	});

	it("moves a quest back to top level with parent=null", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const child = await createQuest(state, "Child");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: parent.id,
		});
		expect(parentOf(child.id)).toBe(parent.id);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: "null",
		});
		expect(result.ok).toBe(true);
		expect(parentOf(child.id)).toBe("null");
	});
});

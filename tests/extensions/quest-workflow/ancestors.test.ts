import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ancestorsOf } from "../../../extensions/quest-workflow/lookup";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return {
		setSessionName: () => {},
		appendEntry: () => {},
	} as unknown as Parameters<typeof handle>[1];
}
function fakeCtx() {
	return {
		cwd: tmpRoot,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}
function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

async function createQuest(
	state: ReturnType<typeof buildState>,
	title: string,
	parent?: string,
): Promise<string> {
	const result = await handle(state, fakePi(), fakeCtx(), {
		action: "create",
		title,
		...(parent ? { kind: "subquest", parent } : {}),
	});
	if (!result.ok) throw new Error(result.guidance);
	return (result.details as { id: string }).id;
}

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "ancestors-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("ancestorsOf", () => {
	it("traces the parent chain nearest-first", async () => {
		const state = buildState();
		const root = await createQuest(state, "Root");
		const mid = await createQuest(state, "Mid", root);
		const leaf = await createQuest(state, "Leaf", mid);

		const chain = ancestorsOf(state, leaf);
		expect(chain?.map((a) => a.id)).toEqual([mid, root]);
	});

	it("returns an empty chain for a top-level quest", async () => {
		const state = buildState();
		const top = await createQuest(state, "Top");
		expect(ancestorsOf(state, top)).toEqual([]);
	});

	it("returns undefined for an unknown id", () => {
		const state = buildState();
		expect(ancestorsOf(state, "QEST-20260101-NOPE00")).toBeUndefined();
	});

	it("is reachable through the ancestors verb", async () => {
		const state = buildState();
		const root = await createQuest(state, "Root");
		const child = await createQuest(state, "Child", root);
		const result = await handle(state, fakePi(), fakeCtx(), {
			action: "ancestors",
			id: child,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(
			(result.details as { ancestors: { id: string }[] }).ancestors,
		).toHaveLength(1);
	});
});

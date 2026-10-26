import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
		sessionManager: {
			getSessionId: () => "sess-1",
			isPersisted: () => true,
			getEntries: () => [],
		},
	} as unknown as Parameters<typeof handle>[2];
}

function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-stage-flow-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("document stage flow", () => {
	it("lets draft override a wrong think-time kind before minting", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(), {
			action: "create",
			kind: "quest",
			title: "Kind Fix",
		});
		await handle(state, fakePi(), fakeCtx(), {
			action: "think",
			kind: "research",
			note: "investigate",
		});
		expect(state.documentKind).toBe("research");

		const drafted = await handle(state, fakePi(), fakeCtx(), {
			action: "draft",
			title: "Actually A Plan",
			kind: "plan",
		});
		expect(drafted.ok).toBe(true);
		expect(state.documentKind).toBe("plan");
		expect(state.documentId?.startsWith("PLAN-")).toBe(true);
	});

	it("thinks and drafts in one call when given a note and a title", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(), {
			action: "create",
			kind: "quest",
			title: "One Call",
		});

		const bare = await handle(state, fakePi(), fakeCtx(), {
			action: "draft",
			title: "No Note",
		});
		expect(bare.ok === false && bare.guidance).toContain("`note`");
		expect(state.documentStage).toBe("idle");

		const drafted = await handle(state, fakePi(), fakeCtx(), {
			action: "draft",
			kind: "research",
			note: "why it is slow",
			title: "Why It Is Slow",
		});
		expect(drafted.ok).toBe(true);
		expect(state.documentStage).toBe("draft");
		expect(state.documentId?.startsWith("RSCH-")).toBe(true);
	});

	it("puts a concluded document down, and starts afresh beside it", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(), {
			action: "create",
			kind: "quest",
			title: "Afresh",
		});
		await handle(state, fakePi(), fakeCtx(), {
			action: "draft",
			kind: "research",
			note: "first question",
			title: "First",
		});
		const first = state.documentPath as string;
		const firstId = state.documentId;

		const concluded = await handle(state, fakePi(), fakeCtx(), {
			action: "conclude",
		});
		expect(concluded.ok).toBe(true);
		expect(state.documentStage).toBe("idle");
		expect(state.documentPath).toBeNull();
		expect(readFileSync(first, "utf8")).toContain("stage: concluded");

		// A finished document focused again is not reopened by think.
		await handle(state, fakePi(), fakeCtx(), {
			action: "focus",
			id: firstId ?? "",
		});
		expect(state.documentStage).toBe("concluded");
		const fresh = await handle(state, fakePi(), fakeCtx(), {
			action: "think",
			note: "the next question",
		});
		expect(fresh.ok && fresh.message).toContain("stays concluded");
		expect(state.documentStage).toBe("think");
		expect(state.documentId).toBeNull();
		expect(readFileSync(first, "utf8")).toContain("stage: concluded");
	});

	it("drafts a titled document beside one in build, leaving that one in build", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(), {
			action: "create",
			kind: "quest",
			title: "Beside",
		});
		await handle(state, fakePi(), fakeCtx(), {
			action: "draft",
			note: "the plan",
			title: "The Plan",
		});
		await handle(state, fakePi(), fakeCtx(), { action: "build" });
		const plan = state.documentPath as string;
		const planId = state.documentId;

		const beside = await handle(state, fakePi(), fakeCtx(), {
			action: "draft",
			kind: "research",
			note: "a question the plan raised",
			title: "The Question",
		});

		expect(beside.ok && beside.message).toContain(
			`${planId} stays in build, put down`,
		);
		expect(state.documentStage).toBe("draft");
		expect(state.documentKind).toBe("research");
		expect(state.documentId).not.toBe(planId);
		expect(readFileSync(plan, "utf8")).toContain("stage: build");
	});

	it("thinks with a kind beside a plan in build, leaving that one in build", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(), {
			action: "create",
			kind: "quest",
			title: "Think Beside",
		});
		await handle(state, fakePi(), fakeCtx(), {
			action: "draft",
			note: "the plan",
			title: "The Plan",
		});
		await handle(state, fakePi(), fakeCtx(), { action: "build" });
		const plan = state.documentPath as string;
		const planId = state.documentId;

		const beside = await handle(state, fakePi(), fakeCtx(), {
			action: "think",
			kind: "research",
			note: "a question the plan raised",
		});

		expect(beside.ok && beside.message).toContain(
			`${planId} stays in build, put down`,
		);
		expect(state.documentStage).toBe("think");
		expect(state.documentKind).toBe("research");
		expect(state.documentId).toBeNull();
		expect(readFileSync(plan, "utf8")).toContain("stage: build");
	});

	it("sends the focused document back to think when think has no kind", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(), {
			action: "create",
			kind: "quest",
			title: "Back To Think",
		});
		await handle(state, fakePi(), fakeCtx(), {
			action: "draft",
			note: "the plan",
			title: "The Plan",
		});
		await handle(state, fakePi(), fakeCtx(), { action: "build" });
		const planId = state.documentId;

		const back = await handle(state, fakePi(), fakeCtx(), {
			action: "think",
			note: "the plan met something it did not expect",
		});

		expect(back.ok).toBe(true);
		expect(state.documentStage).toBe("think");
		expect(state.documentId).toBe(planId);
	});

	it("still refuses draft from build with no title, since nothing new is named", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(), {
			action: "create",
			kind: "quest",
			title: "No Title",
		});
		await handle(state, fakePi(), fakeCtx(), {
			action: "draft",
			note: "the plan",
			title: "The Plan",
		});
		await handle(state, fakePi(), fakeCtx(), { action: "build" });

		const again = await handle(state, fakePi(), fakeCtx(), { action: "draft" });

		expect(again.ok).toBe(false);
		expect(state.documentStage).toBe("build");
	});

	it("does not advance the stage in memory when the disk write fails", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(), {
			action: "create",
			kind: "quest",
			title: "Stage Flow",
		});
		await handle(state, fakePi(), fakeCtx(), {
			action: "think",
			kind: "plan",
			note: "investigate",
		});
		await handle(state, fakePi(), fakeCtx(), {
			action: "draft",
			title: "Doc One",
		});
		expect(state.documentStage).toBe("draft");

		// Remove the document file so the stage write cannot persist.
		const docPath = state.documentPath as string;
		rmSync(docPath, { force: true });

		const built = await handle(state, fakePi(), fakeCtx(), {
			action: "build",
		});
		expect(built.ok).toBe(false);
		// Memory must not run ahead of a disk write that never happened.
		expect(state.documentStage).toBe("draft");
	});
});

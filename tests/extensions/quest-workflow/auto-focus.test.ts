/**
 * Loading a quest focuses the plan it is being worked through, so work
 * does not run with a quest loaded and no plan in view.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persist, restore } from "../../../extensions/quest-workflow/lifecycle";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;
const envGuard = createEnvGuard();

/** A pi that keeps what the workflow persists, so restore can read it. */
function fakePi(entries: { customType: string; data: unknown }[] = []) {
	return {
		setSessionName: () => {},
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ customType, data }),
	} as unknown as Parameters<typeof handle>[1];
}
function fakeCtx(entries: { customType: string; data: unknown }[] = []) {
	return {
		cwd: tmpRoot,
		sessionManager: {
			getSessionId: () => "sess-1",
			getEntries: () => entries.map((e) => ({ type: "custom", ...e })),
			getBranch: () => entries.map((e) => ({ type: "custom", ...e })),
		},
	} as unknown as Parameters<typeof handle>[2];
}

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "auto-focus-"));
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

/** A quest with the plans named, each drafted and left as given. */
async function questWithPlans(
	stages: ("build" | "draft" | "concluded")[],
): Promise<{
	state: ReturnType<typeof createQuestState>;
	id: string;
	plans: string[];
}> {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const pi = fakePi();
	const ctx = fakeCtx();
	const created = await handle(state, pi, ctx, {
		action: "create",
		title: "Focus Quest",
	});
	if (!created.ok) throw new Error(created.guidance);
	const plans: string[] = [];
	for (const [i, stage] of stages.entries()) {
		await handle(state, pi, ctx, {
			action: "think",
			kind: "plan",
			note: `Plan ${i}`,
		});
		const drafted = await handle(state, pi, ctx, {
			action: "draft",
			title: `Plan ${i}`,
		});
		if (!drafted.ok) throw new Error(drafted.guidance);
		const planId = state.documentId ?? "";
		plans.push(planId);
		if (stage === "build" || stage === "concluded") {
			await handle(state, pi, ctx, { action: "build" });
		}
		if (stage === "concluded") {
			await handle(state, pi, ctx, {
				action: "conclude",
				id: planId,
				scope: "document",
			});
		}
		await handle(state, pi, ctx, { action: "unfocus" });
	}
	return { state, id: state.questId ?? "", plans };
}

async function loadFresh(id: string) {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const result = await handle(state, fakePi(), fakeCtx(), {
		action: "load",
		id,
	});
	if (!result.ok) throw new Error(result.guidance);
	return { state, message: result.message };
}

describe("loading a quest", () => {
	it("focuses its primary plan and says so", async () => {
		const { id, plans } = await questWithPlans(["build"]);
		const { state, message } = await loadFresh(id);

		expect(state.documentId).toBe(plans[0]);
		expect(message).toContain(`Focused plan ${plans[0]}.`);
	});

	it("passes over a primary plan that is done for the one still active", async () => {
		const { id, plans } = await questWithPlans(["concluded", "draft"]);
		const { state, message } = await loadFresh(id);

		expect(state.documentId).toBe(plans[1]);
		expect(message).toContain("it is in draft, so `build` before implementing");
	});

	it("names the choice when several plans are active and none is primary", async () => {
		const { id, plans } = await questWithPlans(["concluded", "build", "build"]);
		const { state, message } = await loadFresh(id);

		expect(state.documentId).toBeNull();
		expect(message).toContain("2 active plans (");
		expect(message).toContain(plans[1]);
		expect(message).toContain(plans[2]);
		expect(message).not.toContain(plans[0]);
	});

	it("focuses nothing when every plan is done", async () => {
		const { id } = await questWithPlans(["concluded"]);
		const { state, message } = await loadFresh(id);

		expect(state.documentId).toBeNull();
		expect(message).not.toContain("Focused");
	});
});

describe("resuming a session", () => {
	it("keeps a plan unfocused on purpose unfocused", async () => {
		const { id } = await questWithPlans(["build"]);
		const entries: { customType: string; data: unknown }[] = [];
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		await handle(state, fakePi(entries), fakeCtx(entries), {
			action: "load",
			id,
		});
		await handle(state, fakePi(entries), fakeCtx(entries), {
			action: "unfocus",
		});
		persist(state, fakePi(entries), fakeCtx(entries));

		const resumed = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		restore(resumed, fakePi(entries), fakeCtx(entries));

		expect(resumed.questId).toBe(id);
		expect(resumed.documentId).toBeNull();
	});

	it("focuses the active plan when nothing was focused before", async () => {
		const { id, plans } = await questWithPlans(["build"]);
		const entries = [
			{
				customType: "quest-workflow",
				data: { questId: id, documentPath: null, cwd: tmpRoot },
			},
		];
		const resumed = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		restore(resumed, fakePi(entries), fakeCtx(entries));

		expect(resumed.documentId).toBe(plans[0]);
	});
});

/**
 * What a refused focus tells you.
 *
 * Two refusals cost real time while this quest's own plan was being
 * written. One said a document had "no valid front-matter" without saying
 * which field was wrong, and the answer was found by diffing against a
 * sibling document. The other said the file "does not exist", against a
 * path built from the loaded quest, for a document that exists perfectly
 * well under a different one: `create` switches the loaded quest, so the
 * plan being edited belonged to the quest before it.
 *
 * A refusal that names a location nobody meant is worse than a slow one.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
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

/** What a refusal said, whichever field the result carries it in. */
function refusalText(
	result: { ok: boolean } & Record<string, unknown>,
): string {
	return String(result.guidance ?? result.message ?? "");
}

const envGuard = createEnvGuard();

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-focus-"));
});

afterEach(() => {
	envGuard.leave();
	rmSync(tmpRoot, { recursive: true, force: true });
});

/** A quest with one plan, and the plan's path. */
async function questWithPlan(title: string) {
	const state = buildState();
	await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "create",
		title,
	});
	await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "think",
		note: "why",
	});
	const drafted = await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "draft",
		title: `${title} Plan`,
	});
	return { state, planId: state.documentId ?? "", drafted };
}

describe("focusing a document with incomplete front-matter", () => {
	it("names the fields that are missing", async () => {
		const { state, planId } = await questWithPlan("Name The Field");
		// Every required field but the two this drops. Written directly
		// because no verb produces a document in this state; the one that
		// exposed it had been edited by hand.
		const path = join(state.questDir ?? "", "plans", `${planId}.md`);
		writeFileSync(
			path,
			[
				"---",
				`id: ${planId}`,
				"quest: QEST-1",
				"stage: think",
				"---",
				"",
				"# T",
				"",
			].join("\n"),
			"utf8",
		);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "focus",
			id: planId,
		});

		expect(result.ok).toBe(false);
		expect(refusalText(result)).toContain("kind");
		expect(refusalText(result)).toContain("updated");
	});

	it("says so plainly when there is no front-matter block at all", async () => {
		const { state, planId } = await questWithPlan("No Block");
		const path = join(state.questDir ?? "", "plans", `${planId}.md`);
		writeFileSync(path, "# Just a heading\n", "utf8");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "focus",
			id: planId,
		});

		expect(result.ok).toBe(false);
		expect(refusalText(result)).toMatch(/no front-matter block/i);
	});
});

describe("focusing a document that belongs to another quest", () => {
	it("names the quest that owns it rather than a path nobody meant", async () => {
		const first = await questWithPlan("The First Quest");
		const owner = first.state.questId ?? "";
		const strayId = first.planId;

		// A second quest, loaded, exactly as `create` leaves things.
		const second = buildState();
		await handle(second, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "The Second Quest",
		});

		const result = await handle(second, fakePi(), fakeCtx(tmpRoot), {
			action: "focus",
			id: strayId,
		});

		expect(result.ok).toBe(false);
		expect(refusalText(result)).toContain(owner);
		expect(refusalText(result)).not.toMatch(/does not exist/i);
	});

	it("still says a genuinely absent document is absent", async () => {
		const { state } = await questWithPlan("Nothing Owns It");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "focus",
			id: "PLAN-20990101-ZZZZZZ",
		});

		expect(result.ok).toBe(false);
		expect(refusalText(result)).toMatch(/no document|does not exist/i);
	});
});

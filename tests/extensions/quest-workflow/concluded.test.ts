/**
 * An ending said on pi's bus, for the mesh to tell the orchestrator.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { QUEST_CONCLUDED } from "../../../lib/internal/quest/concluded";
import { createEnvGuard, refused, succeeded } from "./_helpers";

let tmpRoot: string;
const envGuard = createEnvGuard();
let said: [string, unknown][];

function fakePi() {
	return {
		setSessionName: () => {},
		appendEntry: () => {},
		events: {
			emit: (channel: string, data: unknown) => said.push([channel, data]),
			on: () => () => {},
		},
	} as unknown as Parameters<typeof handle>[1];
}
function fakeCtx() {
	return {
		cwd: tmpRoot,
		sessionManager: {
			getSessionId: () => undefined,
			isPersisted: () => false,
			getEntries: () => [],
		},
	} as unknown as Parameters<typeof handle>[2];
}

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "concluded-"));
	said = [];
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("an ending", () => {
	it("is said on the bus with what ended and what the tool answered", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const run = (params: Parameters<typeof handle>[3]) =>
			handle(state, fakePi(), fakeCtx(), params);
		succeeded(await run({ action: "create", title: "Ending Quest" }));
		succeeded(await run({ action: "think", kind: "plan", note: "x" }));
		succeeded(await run({ action: "draft", title: "A Plan" }));
		const planId = state.documentId ?? "";

		succeeded(await run({ action: "conclude" }));

		const endings = said.filter(([channel]) => channel === QUEST_CONCLUDED);
		expect(endings).toHaveLength(1);
		expect(endings[0]?.[1]).toMatchObject({
			how: "concluded",
			ids: [planId],
			said: expect.stringContaining(planId),
		});
	});

	it("is not said for a refusal", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const run = (params: Parameters<typeof handle>[3]) =>
			handle(state, fakePi(), fakeCtx(), params);

		refused(await run({ action: "retire", id: "PLAN-20991231-NOSUCH" }));

		expect(said.filter(([channel]) => channel === QUEST_CONCLUDED)).toEqual([]);
	});
});

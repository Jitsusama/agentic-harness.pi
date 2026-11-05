import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ENDS_AFTER_LOOKS,
	endingCount,
	lookAt,
	type SessionLook,
} from "../../../extensions/quest-workflow/ends-with-quest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { createEnvGuard } from "./_helpers";

const ended: SessionLook = { questEnded: true, busy: false };
const busy: SessionLook = { questEnded: true, busy: true };
const open: SessionLook = { questEnded: false, busy: false };

/** The looks given in turn, and how many it took to end. */
function endsAt(
	looks: readonly (SessionLook | undefined)[],
): number | undefined {
	let at = 0;
	let endedAt: number | undefined;
	const tick = endingCount(
		() => looks[at - 1],
		() => {
			endedAt ??= at;
		},
	);
	for (const _ of looks) {
		at += 1;
		tick();
	}
	return endedAt;
}

describe("a session whose quest has ended", () => {
	it("ends once nothing is left in it for two looks in a row, and only once", () => {
		expect(ENDS_AFTER_LOOKS).toBe(2);
		expect(endsAt([ended, ended, ended])).toBe(2);
		let ends = 0;
		const tick = endingCount(
			() => ended,
			() => {
				ends += 1;
			},
		);
		for (let i = 0; i < 5; i++) tick();
		expect(ends).toBe(1);
	});

	it("starts counting again after a turn, a message or a word typed", () => {
		expect(endsAt([ended, busy, ended, ended])).toBe(4);
	});

	it("keeps running while its quest is open, or it can't be looked at", () => {
		expect(endsAt([open, open, open])).toBeUndefined();
		expect(endsAt([ended, undefined, ended])).toBeUndefined();
	});
});

describe("a look at a session", () => {
	let tmpRoot: string;
	const envGuard = createEnvGuard();
	beforeEach(() => {
		envGuard.enter();
		tmpRoot = mkdtempSync(join(tmpdir(), "ends-with-quest-"));
	});
	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
		envGuard.leave();
	});

	const context = (over: { idle?: boolean; typed?: string } = {}) => ({
		isIdle: () => over.idle ?? true,
		hasPendingMessages: () => false,
		hasUI: true,
		ui: { getEditorText: () => over.typed ?? "" },
	});

	it("reads its quest as another session left it, and sees what is typed", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const created = await handle(
			state,
			{ setSessionName: () => {} } as unknown as Parameters<typeof handle>[1],
			{
				cwd: tmpRoot,
				sessionManager: { getSessionId: () => "sess-1" },
			} as unknown as Parameters<typeof handle>[2],
			{ action: "create", title: "Done Elsewhere" },
		);
		if (!created.ok) throw new Error(created.guidance);
		const look = (over?: { idle?: boolean; typed?: string }) =>
			lookAt(state, context(over) as unknown as Parameters<typeof lookAt>[1]);
		expect(look()).toEqual({ questEnded: false, busy: false });

		// Another session concludes it, on disk.
		const readme = join(state.questDir as string, "README.md");
		writeFileSync(
			readme,
			readFileSync(readme, "utf8").replace(
				/^status: \w+$/m,
				"status: concluded",
			),
		);
		expect(look()).toEqual({ questEnded: true, busy: false });
		expect(look({ typed: "one more thing" })).toEqual({
			questEnded: true,
			busy: true,
		});
		expect(look({ idle: false }).busy).toBe(true);
	});

	it("never ends a session with no quest loaded", () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		expect(
			lookAt(state, context() as unknown as Parameters<typeof lookAt>[1])
				.questEnded,
		).toBe(false);
	});
});

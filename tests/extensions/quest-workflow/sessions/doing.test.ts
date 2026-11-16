/**
 * The quest workflow says what its session is doing for the presence:
 * the focused plan's next item, said again only when it moves, taken
 * away once the session ends, and a failed write told to the person.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import {
	forgetDoing,
	keepDoingSaid,
	readDoing,
} from "../../../../lib/internal/quest/doing.ts";

let dir: string;
const session = "sess-doing";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "quest-doing-"));
	writeFileSync(join(dir, "README.md"), "# Q\n");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** The session's notices, and what they told the person. */
function notices() {
	const told: string[] = [];
	return { told, notify: (text: string) => told.push(text) };
}

/** A state with a plan focused at `currentItem`. */
function planAt(currentItem: string) {
	const state = createQuestState({ questsRoot: dir });
	state.questDir = dir;
	state.documentId = "PLAN-1";
	state.documentKind = "plan";
	state.currentItem = currentItem;
	return state;
}

describe("what the session is doing", () => {
	it("is said for the presence, and taken away once the session ends", () => {
		const folder = join(dir, "doing");
		keepDoingSaid(planAt("3. Say it"), session, notices(), folder);
		expect(readDoing(folder, session), "the plan's next item").toMatchObject({
			plan: "PLAN-1",
			item: 3,
			next: "Say it",
		});
		forgetDoing(session, folder);
		expect(readDoing(folder, session), "gone at the end").toBeUndefined();
	});

	it("tells the person when it can't be said", () => {
		const folder = join(dir, "doing");
		writeFileSync(folder, "a file where the folder should be");
		const said = notices();
		keepDoingSaid(planAt("3. Say it"), session, said, folder);
		expect(said.told, "one warning naming the map").toHaveLength(1);
		expect(said.told[0], "says what's missing").toContain("The map can't show");
	});
});

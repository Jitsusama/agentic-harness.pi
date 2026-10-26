/**
 * Undo takes back only its own session's newest structural change.
 *
 * On 25 October two sessions, each meaning to undo a write of its own,
 * reversed 7SU7HB's day-old conclude instead, because undo took the
 * newest change on the machine whoever made it.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { setJournalSession } from "../../../lib/internal/quest/structural-journal";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index";
import { createEnvGuard, refused, succeeded } from "./_helpers";

let tmpRoot: string;
let guard: ReturnType<typeof createEnvGuard>;

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}

/** A tool call's context, from the session with this id. */
function asSession(session: string) {
	return {
		cwd: tmpRoot,
		sessionManager: { getSessionId: () => session },
	} as unknown as Parameters<typeof handle>[2];
}

function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

async function createQuest(
	state: ReturnType<typeof buildState>,
	title: string,
): Promise<string> {
	const result = await handle(state, fakePi(), asSession("maker"), {
		action: "create",
		title,
	});
	return (succeeded(result).details as { id: string }).id;
}

function parentOf(id: string): string {
	const text = readFileSync(join(tmpRoot, "quests", id, "README.md"), "utf8");
	const line = text.split("\n").find((one) => one.startsWith("parent:"));
	return (line ?? "").replace("parent:", "").trim();
}

async function reparent(
	state: ReturnType<typeof buildState>,
	session: string,
	id: string,
	parent: string,
): Promise<void> {
	succeeded(
		await handle(state, fakePi(), asSession(session), {
			action: "reparent",
			id,
			parent,
		}),
	);
}

beforeEach(() => {
	guard = createEnvGuard();
	guard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "undo-own-"));
	clearRefTypes();
	registerBuiltinRefTypes();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	setJournalSession(undefined);
	guard.leave();
	clearRefTypes();
});

describe("undo", () => {
	it("never reaches another session's change, as 7SU7HB's undo did", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const quest = await createQuest(state, "7SU7HB");
		await reparent(state, "orchestrator", quest, parent);

		const result = await handle(state, fakePi(), asSession("helper"), {
			action: "undo",
		});

		expect(refused(result).guidance).toContain(
			"Nothing to undo: this session has made no structural change",
		);
		expect(parentOf(quest)).toBe(parent);
	});

	it("takes back its own newest change, past another session's later one", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const mine = await createQuest(state, "Mine");
		const theirs = await createQuest(state, "Theirs");
		await reparent(state, "helper", mine, parent);
		await reparent(state, "orchestrator", theirs, parent);

		succeeded(
			await handle(state, fakePi(), asSession("helper"), { action: "undo" }),
		);

		expect(parentOf(mine)).toBe("null");
		expect(parentOf(theirs)).toBe(parent);
	});

	it("refuses when another session has changed the same quest since", async () => {
		const state = buildState();
		const first = await createQuest(state, "First");
		const second = await createQuest(state, "Second");
		const quest = await createQuest(state, "Shared");
		await reparent(state, "helper", quest, first);
		await reparent(state, "orchestrator", quest, second);

		const result = await handle(state, fakePi(), asSession("helper"), {
			action: "undo",
		});

		expect(refused(result).guidance).toContain(
			"another session has changed the same quests since",
		);
		expect(parentOf(quest)).toBe(second);
	});

	it("refuses an id its own newest change did not touch", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const mine = await createQuest(state, "Mine");
		const other = await createQuest(state, "Other");
		await reparent(state, "helper", mine, parent);

		const result = await handle(state, fakePi(), asSession("helper"), {
			action: "undo",
			id: other,
		});

		expect(refused(result).guidance).toContain(`did not touch ${other}`);
		expect(parentOf(mine)).toBe(parent);
	});
});

/**
 * The sessions a quest records: attaching one, detaching it only by
 * its owner, keeping it active on one quest at a time, and naming it.
 */

import { describe, expect, it } from "vitest";
import {
	attachCurrentSession,
	attachSessionInQuestDir,
	detachSessionFromLoaded,
	detachSessionIfOwner,
	detachSessionInQuestDir,
	reconcileSessionMembership,
	renameSessionInQuestDir,
} from "../../../lib/core/quest/lifecycle.ts";
import type { QuestSession } from "../../../lib/quest/index.ts";
import {
	loadIntoState,
	questOnDisk,
	seedQuest,
	useQuestsRoot,
} from "./support/quests.ts";

const state = useQuestsRoot();

const FIRST = "2026-01-01T00:00:00.000Z";

/** The session `id` as the quest in `questDir` records it. */
function sessionOf(questDir: string, id: string): QuestSession | undefined {
	return questOnDisk(questDir).sessions.find((s) => s.id === id);
}

describe("attachSessionInQuestDir", () => {
	it("adds a session once and keeps when it first attached", () => {
		const dir = seedQuest(state(), "A");
		expect(
			attachSessionInQuestDir(dir, { id: "s1", started: FIRST, status: "active" }),
		).toEqual({ ok: true, added: true });
		detachSessionInQuestDir(dir, "s1");
		expect(
			attachSessionInQuestDir(dir, {
				id: "s1",
				started: "2026-02-02T00:00:00.000Z",
				status: "active",
				cwd: "/work",
			}),
		).toEqual({ ok: true, added: false });
		expect(questOnDisk(dir).sessions).toEqual([
			{ id: "s1", started: FIRST, status: "active", cwd: "/work" },
		]);
	});

	it("leaves the README alone when an attach changes nothing", () => {
		const dir = seedQuest(state(), "A", {
			sessions: [{ id: "s1", started: FIRST, status: "active" }],
		});
		const before = questOnDisk(dir).updated;
		attachSessionInQuestDir(dir, { id: "s1", started: FIRST, status: "active" });
		expect(questOnDisk(dir).updated).toBe(before);
	});
});

describe("attachCurrentSession", () => {
	it("records the session with where it runs and who holds it", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		loadIntoState(s, dir);
		expect(
			attachCurrentSession(s, { id: "s1", cwd: " /work ", instanceId: "i1" }),
		).toEqual({ attached: true });
		expect(sessionOf(dir, "s1")).toMatchObject({
			status: "active",
			cwd: "/work",
			instanceId: "i1",
		});
	});

	it("records nothing for an ephemeral session, an unknown id or no quest", () => {
		const s = state();
		expect(attachCurrentSession(s, { id: "s1" })).toEqual({ attached: false });
		const dir = seedQuest(s, "A");
		loadIntoState(s, dir);
		expect(attachCurrentSession(s, { id: undefined })).toEqual({
			attached: false,
		});
		expect(attachCurrentSession(s, { id: "s1", persisted: false })).toEqual({
			attached: false,
		});
		expect(questOnDisk(dir).sessions).toEqual([]);
	});
});

describe("detaching", () => {
	it("asks for a quest when none is loaded", () => {
		expect(detachSessionFromLoaded(state(), "s1")).toEqual({
			ok: false,
			guidance: "Load a quest first.",
		});
	});

	it("detaches once and says so", () => {
		const dir = seedQuest(state(), "A", {
			sessions: [{ id: "s1", status: "active" }],
		});
		expect(detachSessionInQuestDir(dir, "s1")).toEqual({
			ok: true,
			detached: true,
		});
		expect(detachSessionInQuestDir(dir, "s1")).toEqual({
			ok: true,
			detached: false,
		});
		expect(detachSessionInQuestDir(dir, "s2")).toEqual({
			ok: true,
			detached: false,
		});
	});

	it("detaches a record without an owner, and leaves another owner's", () => {
		const dir = seedQuest(state(), "A", {
			sessions: [
				{ id: "legacy", status: "active" },
				{ id: "held", status: "active", instanceId: "theirs" },
			],
		});
		expect(detachSessionIfOwner(dir, "legacy", "mine")).toEqual({
			ok: true,
			detached: true,
		});
		expect(detachSessionIfOwner(dir, "held", "mine")).toEqual({
			ok: true,
			detached: false,
		});
		expect(sessionOf(dir, "held")?.status).toBe("active");
		expect(detachSessionIfOwner(dir, "held", "theirs")).toEqual({
			ok: true,
			detached: true,
		});
	});
});

describe("reconcileSessionMembership", () => {
	it("leaves a session active only on the quest it keeps", () => {
		const s = state();
		const active = { id: "s1", status: "active" as const };
		const kept = seedQuest(s, "Kept", { sessions: [active] });
		const stray = seedQuest(s, "Stray", { sessions: [active] });
		const done = seedQuest(s, "Done", {
			sessions: [{ id: "s1", status: "detached" }],
		});
		const keptId = questOnDisk(kept).id;
		expect(reconcileSessionMembership(s, "s1", keptId)).toEqual([
			questOnDisk(stray).id,
		]);
		expect([kept, stray, done].map((d) => sessionOf(d, "s1")?.status)).toEqual([
			"active",
			"detached",
			"detached",
		]);
	});
});

describe("renameSessionInQuestDir", () => {
	it("names a session, saying when the name was already its own", () => {
		const dir = seedQuest(state(), "A", {
			sessions: [{ id: "s1", status: "active" }],
		});
		expect(renameSessionInQuestDir(dir, "s1", "builder")).toEqual({
			ok: true,
			renamed: true,
		});
		expect(renameSessionInQuestDir(dir, "s1", "builder")).toEqual({
			ok: true,
			renamed: false,
		});
		expect(renameSessionInQuestDir(dir, "s2", "builder")).toEqual({
			ok: true,
			renamed: false,
		});
		expect(sessionOf(dir, "s1")?.name).toBe("builder");
	});
});

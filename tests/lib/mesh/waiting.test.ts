/**
 * Waiting: what a quest has waiting on its person, in the file the
 * launcher reads.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addWaiting,
	applyVerdicts,
	clearWaiting,
	isKnowing,
	settleWaiting,
	verdictsFile,
	verdictsIn,
	type WaitingItem,
	waitingFile,
	waitingFolder,
	waitingOf,
	wantFor,
} from "../../../lib/mesh/waiting.ts";

let folder: string;
const QUEST = "QEST-20261025-QCXZEB";
const at = new Date("2026-10-26T03:00:00.000Z");

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "waiting-"));
});
afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

const item = (over: Partial<WaitingItem> = {}): WaitingItem => ({
	id: "eero-login",
	title: "Log in to eero",
	why: "Only Joel has the account",
	minutes: 2,
	when: "now",
	window: null,
	quest: QUEST,
	ready: false,
	doneWhen: { check: "test -e /run/eero-joined" },
	...over,
});

describe("the want presence says for what waits", () => {
	// The desktop raises a notice for each want, so an item he can't do
	// yet must never make one: on 2026-10-26 sessions reloading put up
	// notices for items their quests never set ready.
	it("is nothing while no item is ready", () => {
		const items = [item(), item({ id: "mic-try", title: "Try the mic" })];
		expect(wantFor(items, undefined, at)).toBeUndefined();
		expect(wantFor([], undefined, at)).toBeUndefined();
	});

	it("names the first ready item and counts only the ready ones", () => {
		const items = [
			item({ id: "later", title: "Later" }),
			item({ id: "now", title: "Now", ready: true }),
			item({ id: "also", title: "Also now", ready: true }),
		];
		expect(wantFor(items, undefined, at)).toEqual({
			kind: "action",
			since: at.toISOString(),
			said: "Now and 1 more",
		});
	});

	it("keeps the time of a want already standing", () => {
		const items = [item({ ready: true })];
		const standing = "2026-10-26T01:00:00.000Z";
		expect(wantFor(items, standing, at)?.since).toBe(standing);
	});
});

describe("what waits on the person", () => {
	it("is kept per quest under its address, in the shape the launcher reads", () => {
		addWaiting(folder, item(), at);

		expect(waitingFile(folder, QUEST)).toBe(join(folder, "QCXZEB.json"));
		expect(
			JSON.parse(readFileSync(join(folder, "QCXZEB.json"), "utf8")),
		).toEqual({
			v: 2,
			updated: "2026-10-26T03:00:00.000Z",
			quest: QUEST,
			items: [item()],
		});
		expect(readdirSync(folder)).toEqual(["QCXZEB.json"]);
	});

	it("replaces an item said again under its id, so ready can be said later", () => {
		addWaiting(folder, item(), at);
		addWaiting(folder, item({ id: "look", title: "Look at the sheet" }), at);

		const items = addWaiting(folder, item({ ready: true }), at);

		expect(items.map((one) => [one.id, one.ready])).toEqual([
			["eero-login", true],
			["look", false],
		]);
	});

	it("removes the file when the last item is settled", () => {
		addWaiting(folder, item(), at);
		addWaiting(folder, item({ id: "look" }), at);

		expect(settleWaiting(folder, QUEST, "eero-login", at)).toHaveLength(1);
		expect(settleWaiting(folder, QUEST, "look", at)).toEqual([]);
		expect(existsSync(join(folder, "QCXZEB.json"))).toBe(false);
	});

	it("is nothing for a quest with no file", () => {
		expect(waitingOf(folder, QUEST)).toEqual([]);
	});

	it("reads an item written before items said how as the person's to settle", () => {
		const { doneWhen: _, ...before } = item();
		writeFileSync(
			waitingFile(folder, QUEST),
			JSON.stringify({ updated: "x", quest: QUEST, items: [before] }),
		);

		expect(waitingOf(folder, QUEST)).toEqual([
			item({ doneWhen: { by: "person" } }),
		]);
	});

	it("goes with its quest", () => {
		addWaiting(folder, item(), at);
		clearWaiting(folder, QUEST);
		expect(existsSync(waitingFile(folder, QUEST))).toBe(false);
	});

	it("is kept under the state home, or its default when that is empty", () => {
		expect(waitingFolder({ XDG_STATE_HOME: "/s" }, "/h")).toBe(
			"/s/mission/waiting",
		);
		expect(waitingFolder({ XDG_STATE_HOME: "" }, "/h")).toBe(
			"/h/.local/state/mission/waiting",
		);
	});
});

describe("how an item is known done or ready", () => {
	it("is one check, one signal the desktop knows, or the person", () => {
		for (const said of [
			{ check: "test -e /x" },
			{ signal: "boot" },
			{ signal: "switch" },
			{ signal: "switch:da1523f9" },
			{ signal: "signin:google" },
			{ signal: "device:dock" },
			{ signal: "file:/run/user/1000/done" },
			{ by: "person" },
		]) {
			expect(isKnowing(said), JSON.stringify(said)).toBe(true);
		}
		for (const said of [
			undefined,
			{},
			{ check: " " },
			{ signal: "tomorrow" },
			{ signal: "file:relative" },
			{ by: "agent" },
			{ check: "x", signal: "boot" },
		]) {
			expect(isKnowing(said), JSON.stringify(said)).toBe(false);
		}
	});
});

describe("the desktop's verdicts", () => {
	const verdicts = (items: Record<string, unknown>) => {
		const path = verdictsFile(join(folder, "waiting"));
		mkdirSync(folder, { recursive: true });
		writeFileSync(path, JSON.stringify({ v: 1, updated: "x", items }));
		return verdictsIn(path);
	};

	it("settle what it found done and mark ready what it found ready", () => {
		addWaiting(folder, item(), at);
		addWaiting(folder, item({ id: "look" }), at);
		addWaiting(folder, item({ id: "sign" }), at);

		const { items, changed } = applyVerdicts(
			folder,
			QUEST,
			verdicts({
				[`${QUEST}:eero-login`]: {
					state: "done",
					at: "t",
					how: { check: true },
				},
				[`${QUEST}:look`]: { state: "ready", at: "t", how: { signal: "boot" } },
				"QEST-20261025-OTHERS:sign": { state: "done", at: "t" },
			}),
			at,
		);

		expect(changed).toBe(true);
		expect(items.map((one) => [one.id, one.ready])).toEqual([
			["look", true],
			["sign", false],
		]);
		expect(waitingOf(folder, QUEST)).toEqual(items);
	});

	it("are none while the daemon has written none", () => {
		expect(verdictsIn(join(folder, "verdicts.json")).size).toBe(0);
		addWaiting(folder, item(), at);
		expect(applyVerdicts(folder, QUEST, new Map(), at).changed).toBe(false);
	});

	it("sit beside the folder of quests' files", () => {
		expect(verdictsFile("/s/mission/waiting")).toBe("/s/mission/verdicts.json");
	});
});

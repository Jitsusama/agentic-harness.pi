/**
 * Waiting: what a quest has waiting on its person, in the file the
 * launcher reads.
 */
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addWaiting,
	settleWaiting,
	type WaitingItem,
	waitingFile,
	waitingOf,
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
	...over,
});

describe("what waits on the person", () => {
	it("is kept per quest under its address, in the shape the launcher reads", () => {
		addWaiting(folder, item(), at);

		expect(waitingFile(folder, QUEST)).toBe(join(folder, "QCXZEB.json"));
		expect(
			JSON.parse(readFileSync(join(folder, "QCXZEB.json"), "utf8")),
		).toEqual({
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
});

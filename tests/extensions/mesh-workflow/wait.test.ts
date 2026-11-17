/**
 * What a session raised for its person, watched for something else
 * settling it: read off the host's thread on its clock, as on it.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createWaits,
	type WaitsOn,
} from "../../../extensions/mesh-workflow/peer/waits.ts";
import {
	type SettleWatch,
	type Waiting,
	watchSettling,
} from "../../../extensions/mesh-workflow/wait.ts";
import {
	addWaiting,
	verdictsFile,
	type WaitingItem,
	waitingFile,
} from "../../../lib/mesh/waiting.ts";

const QUEST = "QEST-20261025-QCXZEB";
const OWNER = { session: "this-session", address: "QCXZEB" };

let root: string;
let folder: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "settling-"));
	folder = join(root, "waiting");
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const item = (id: string): WaitingItem => ({
	id,
	title: `Do ${id}`,
	why: "Only Joel has the account",
	minutes: 2,
	window: null,
	quest: QUEST,
	ready: true,
	doneWhen: { by: "person" },
	owner: OWNER,
});

const waitingOn = (quest: () => string | undefined = () => QUEST): Waiting => ({
	folder,
	quest,
	window: () => undefined,
	owner: () => OWNER,
});

const found = (states: Record<string, "done" | "ready">) =>
	writeFileSync(
		verdictsFile(folder),
		JSON.stringify({
			v: 1,
			updated: "t",
			items: Object.fromEntries(
				Object.entries(states).map(([id, state]) => [
					`${QUEST}:${id}`,
					{ state, at: "t" },
				]),
			),
		}),
	);

const idsOf = (items: readonly WaitingItem[]) => items.map((one) => one.id);

describe("what this session raised, read off the thread", () => {
	it("says what settled as a look on the thread does, writing the verdict", async () => {
		addWaiting(folder, item("eero-login"));
		addWaiting(folder, item("router-look"));
		const watch = watchSettling(waitingOn());
		expect(await watch.settledOff(), "the first look only learns").toEqual([]);
		found({ "eero-login": "done" });

		expect(idsOf(await watch.settledOff())).toEqual(["eero-login"]);
		const kept = JSON.parse(readFileSync(waitingFile(folder, QUEST), "utf8"));
		expect(idsOf(kept.items), "the verdict written").toEqual(["router-look"]);
		expect(watch.watching(), "one still waits").toBe(true);
	});

	it("writes nothing when no verdict changes anything", async () => {
		addWaiting(folder, item("eero-login"));
		const watch = watchSettling(waitingOn());
		await watch.settledOff();
		const before = readFileSync(waitingFile(folder, QUEST), "utf8");
		found({ "eero-login": "ready" });

		expect(await watch.settledOff()).toEqual([]);
		expect(readFileSync(waitingFile(folder, QUEST), "utf8")).toBe(before);
	});

	it("says nothing when the quest changed while it read", async () => {
		addWaiting(folder, item("eero-login"));
		const on = { quest: QUEST as string | undefined };
		const watch = watchSettling(waitingOn(() => on.quest));
		await watch.settledOff();
		// The person cleared it, as the session moved to another quest.
		writeFileSync(
			waitingFile(folder, QUEST),
			JSON.stringify({ v: 2, updated: "t", quest: QUEST, items: [] }),
		);

		const reading = watch.settledOff();
		on.quest = "QEST-20261026-OTHERQ";
		expect(await reading, "another quest's items left with it").toEqual([]);
	});

	it("says nothing of what the session heard of itself while it read", async () => {
		addWaiting(folder, item("eero-login"));
		const watch = watchSettling(waitingOn());
		await watch.settledOff();

		const reading = watch.settledOff();
		// The session raised another as the read went on, which it never saw.
		watch.heard([item("eero-login"), item("router-look")]);
		expect(await reading, "what it raised, never told settled").toEqual([]);
		expect(watch.watching(), "still watching what it raised").toBe(true);
	});

	it("says nothing settled when what waits can't be read", async () => {
		addWaiting(folder, item("eero-login"));
		const watch = watchSettling(waitingOn());
		await watch.settledOff();
		writeFileSync(waitingFile(folder, QUEST), '{"v": 2, "items": [');

		await expect(watch.settledOff(), "read again next tick").rejects.toThrow();
		expect(watch.watching(), "still watching").toBe(true);
		// Written whole again, the person having cleared it meanwhile.
		writeFileSync(
			waitingFile(folder, QUEST),
			JSON.stringify({ v: 2, updated: "t", quest: QUEST, items: [] }),
		);
		expect(idsOf(await watch.settledOff()), "told once it reads again").toEqual(
			["eero-login"],
		);
	});

	it("tells what its verdict write settles, once, whatever the file reads after", async () => {
		addWaiting(folder, item("eero-login"));
		addWaiting(folder, item("router-look"));
		const locked: string[] = [];
		const watch = watchSettling({
			...waitingOn(),
			locked: (quest, apply) => {
				const done = apply();
				locked.push(quest);
				// Torn just after the write, as another writer might leave it.
				writeFileSync(waitingFile(folder, QUEST), '{"v": 2, "items": [');
				return done;
			},
		});
		await watch.settledOff();
		found({ "eero-login": "done" });

		expect(idsOf(await watch.settledOff()), "what the verdict settled").toEqual(
			["eero-login"],
		);
		expect(locked, "written under the lock").toEqual([QUEST]);
		await expect(
			watch.settledOff(),
			"torn, read again next tick",
		).rejects.toThrow();
		addWaiting(folder, item("router-look"));
		expect(await watch.settledOff(), "never told twice").toEqual([]);
		expect(watch.watching(), "still watching what waits").toBe(true);
	});

	it("tells a verdict whose write failed at the tick that writes it", async () => {
		addWaiting(folder, item("eero-login"));
		let fails = true;
		const watch = watchSettling({
			...waitingOn(),
			locked: (_quest, apply) => {
				if (fails) throw new Error("locked out");
				return apply();
			},
		});
		await watch.settledOff();
		found({ "eero-login": "done" });

		await expect(watch.settledOff(), "the write failed").rejects.toThrow(
			"locked out",
		);
		fails = false;
		expect(idsOf(await watch.settledOff()), "told once written").toEqual([
			"eero-login",
		]);
	});

	it("answers nothing to a look while another still reads", async () => {
		addWaiting(folder, item("eero-login"));
		const watch = watchSettling(waitingOn());
		await watch.settledOff();
		found({ "eero-login": "done" });

		const first = watch.settledOff();
		expect(await watch.settledOff(), "passed over").toEqual([]);
		expect(idsOf(await first), "told once").toEqual(["eero-login"]);
	});
});

describe("the settle clock", () => {
	const sent: string[] = [];
	const on = (settledOff: (m: WaitsOn) => Promise<WaitingItem[]>) => {
		const watch: SettleWatch = {
			heard: () => undefined,
			settled: () => [],
			settledOff: () => settledOff(m),
			watching: () => true,
		};
		const m: WaitsOn = {
			settleWatch: watch,
			waitClock: undefined,
			settleClock: undefined,
			turnAsked: false,
			// Never ticks by itself: each test ticks it.
			waitCheckMs: 3_600_000,
			pi: { sendMessage: (message) => void sent.push(String(message.content)) },
			ctx: { isIdle: () => true },
			pausing: { paused: false },
			leasing: { lapsed: async () => [] },
			own: undefined,
			resumes: undefined,
		};
		return { m, waits: createWaits(m) };
	};
	beforeEach(() => {
		sent.length = 0;
	});

	it("tells the session what settled", async () => {
		const { m, waits } = on(async () => [item("eero-login")]);
		waits.watchSettled();
		await waits.tellSettled();
		clearInterval(m.settleClock);

		expect(sent.length, "one note").toBe(1);
		expect(sent[0], "naming it").toContain("eero-login");
	});

	it("tells nothing to a session that went while it read", async () => {
		const { m, waits } = on(async (state) => {
			// What session_shutdown does with the clock.
			clearInterval(state.settleClock);
			state.settleClock = undefined;
			return [item("eero-login")];
		});
		waits.watchSettled();
		await waits.tellSettled();
		clearInterval(m.settleClock);

		expect(sent, "the ended session told nothing").toEqual([]);
	});

	it("keeps ticking past a read that fails", async () => {
		const { m, waits } = on(async () => {
			throw new SyntaxError("torn");
		});
		waits.watchSettled();
		const clock = m.settleClock;
		await waits.tellSettled();

		expect(sent, "nothing told").toEqual([]);
		expect(m.settleClock, "the clock still runs").toBe(clock);
		clearInterval(m.settleClock);
	});
});

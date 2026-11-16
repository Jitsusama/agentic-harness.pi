import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type HoldingDeps,
	tendHolds,
} from "../../../extensions/pineapple-workflow/holding.ts";
import {
	END_TEXT,
	HOLD_SENDER,
	RENEW_MS,
} from "../../../lib/internal/pineapple/hold.ts";
import { type Stop, stopOf } from "../../../lib/internal/pineapple/stops.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";

function stop(id: string, reaches: string[], shadow = false): Stop {
	const made = stopOf({ shadow, reaches }, id);
	if (!made) throw new Error("a stop with no resume is made");
	return made;
}

function mesh(over: Partial<HoldingDeps> = {}) {
	const root = mkdtempSync(join(tmpdir(), "pineapple-holds-"));
	const transport = folderTransport(join(root, "messages"));
	const clock = { now: 10 * RENEW_MS };
	const state = { stops: [] as Stop[] };
	const sent = () => transport.ids().map((id) => transport.read(id));
	const tend = () =>
		tendHolds({
			stops: () => state.stops,
			notes: join(root, "pineapple"),
			send: (draft) => transport.send(draft),
			shadowLog: join(root, "would-hold.jsonl"),
			realm: "work",
			chainOf: (quest) => [quest],
			pid: 4242,
			now: () => clock.now,
			...over,
		});
	return { root, clock, state, sent, tend };
}

describe("tending holds", () => {
	it("touches the disk only off the caller's turn", async () => {
		const { state, sent, tend } = mesh();
		state.stops = [stop("q", ["quest:QEST-A"])];
		const tending = tend();
		// A pool thread may make the folder at once, but the claim and the
		// notes are read only as this thread carries on, so nothing is sent
		// on the caller's turn.
		expect(sent(), "a hold sent on the caller's turn").toEqual([]);
		await tending;
		expect(sent(), "the hold sent once tending settles").toHaveLength(1);
	});

	it("sends one hold for a stop, from the safe word's address", async () => {
		const { state, sent, tend } = mesh();
		state.stops = [stop("q", ["quest:QEST-A"])];
		await tend();
		await tend();
		const messages = sent();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			from: HOLD_SENDER,
			intent: "hold",
			to: ["#quest/a"],
		});
	});

	it("renews a hold before its two hours end, replacing the last", async () => {
		const { clock, state, sent, tend } = mesh();
		state.stops = [stop("q", ["quest:QEST-A"])];
		await tend();
		clock.now += RENEW_MS;
		await tend();
		const [first, second] = sent();
		expect(second).toMatchObject({ intent: "hold", supersedes: first?.id });
	});

	it("ends the hold once Joel resumes, and keeps no note of it", async () => {
		const { root, state, sent, tend } = mesh();
		state.stops = [stop("q", ["quest:QEST-A"])];
		await tend();
		state.stops = [];
		await tend();
		const [hold, end] = sent();
		expect(end).toMatchObject({
			intent: "fyi",
			supersedes: hold?.id,
			to: ["#quest/a"],
			text: END_TEXT,
		});
		expect(
			existsSync(join(root, "pineapple", "q.json")) ? "kept" : "gone",
		).toBe("gone");
	});

	it("sends nothing for a shadow stop, writing the would-be hold once a renewal", async () => {
		const { root, clock, state, sent, tend } = mesh();
		state.stops = [stop("q", ["everything"], true)];
		await tend();
		await tend();
		clock.now += RENEW_MS;
		await tend();
		expect(sent()).toEqual([]);
		const lines = readFileSync(join(root, "would-hold.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ stop: "q", to: ["#all"] });
	});

	it("leaves the holds to the session tending them, until its claim goes stale", async () => {
		const { root, clock, state, sent, tend } = mesh();
		state.stops = [stop("q", ["quest:QEST-A"])];
		mkdirSync(join(root, "pineapple"), { recursive: true });
		writeFileSync(join(root, "pineapple", "claim"), "1");
		clock.now = Date.now();
		await tend();
		expect(sent()).toEqual([]);
		clock.now = Date.now() + 3 * 60 * 1000;
		await tend();
		expect(sent()).toHaveLength(1);
	});

	// Our council on #1728: tendings started at once settle by the pool's
	// timing, so a second is started inside the first, while its claim,
	// by this clock, reads as stale to any session that looks.
	it("tends once at a time in a process, though its claim reads as stale", async () => {
		const stops = [stop("q", ["quest:QEST-A"])];
		const run: { tendings: number; second?: Promise<void> } = { tendings: 0 };
		const inner: { tend?: () => Promise<void> } = {};
		const { clock, tend } = mesh({
			stops: () => {
				run.tendings += 1;
				return stops;
			},
			send: () => {
				run.second ??= inner.tend?.();
				return { id: "m1" };
			},
		});
		inner.tend = tend;
		clock.now = Date.now() + 3 * 60 * 1000;
		await tend();
		await run.second;
		expect(run.tendings, "tendings past the claim").toBe(1);
	});

	it("leaves a claim another session took meanwhile", async () => {
		const at = { claim: "" };
		const { root, state, tend } = mesh({
			// Another session takes the claim as this one sends.
			send: () => {
				writeFileSync(at.claim, "another");
				return { id: "m1" };
			},
		});
		at.claim = join(root, "pineapple", "claim");
		state.stops = [stop("q", ["quest:QEST-A"])];
		await tend();
		expect(
			existsSync(at.claim) && readFileSync(at.claim, "utf8"),
			"the other session's claim",
		).toBe("another");
	});

	it("ends as it should when its claim went meanwhile", async () => {
		const at = { claim: "" };
		const { root, state, tend } = mesh({
			// Taken back from outside as this one sends.
			send: () => {
				rmSync(at.claim, { force: true });
				return { id: "m1" };
			},
		});
		at.claim = join(root, "pineapple", "claim");
		state.stops = [stop("q", ["quest:QEST-A"])];
		await expect(tend(), "the tending").resolves.toBeUndefined();
		expect(existsSync(at.claim), "no claim").toBe(false);
	});

	it("gives its claim back when tending fails", async () => {
		const failing = { now: true };
		const sends = { count: 0 };
		const { state, tend } = mesh({
			send: () => {
				if (failing.now) throw new Error("the mesh moved");
				sends.count += 1;
				return { id: "m1" };
			},
		});
		state.stops = [stop("q", ["quest:QEST-A"])];
		await expect(tend(), "the failed tending").rejects.toThrow(
			"the mesh moved",
		);
		failing.now = false;
		await tend();
		expect(sends.count, "sent by the next tending").toBe(1);
	});
});

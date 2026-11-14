import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tendHolds } from "../../../extensions/pineapple-workflow/holding.ts";
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

function mesh() {
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
		});
	return { root, clock, state, sent, tend };
}

describe("tending holds", () => {
	it("sends one hold for a stop, from the safe word's address", () => {
		const { state, sent, tend } = mesh();
		state.stops = [stop("q", ["quest:QEST-A"])];
		tend();
		tend();
		const messages = sent();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			from: HOLD_SENDER,
			intent: "hold",
			to: ["#quest/a"],
		});
	});

	it("renews a hold before its two hours end, replacing the last", () => {
		const { clock, state, sent, tend } = mesh();
		state.stops = [stop("q", ["quest:QEST-A"])];
		tend();
		clock.now += RENEW_MS;
		tend();
		const [first, second] = sent();
		expect(second).toMatchObject({ intent: "hold", supersedes: first?.id });
	});

	it("ends the hold once Joel resumes, and keeps no note of it", () => {
		const { root, state, sent, tend } = mesh();
		state.stops = [stop("q", ["quest:QEST-A"])];
		tend();
		state.stops = [];
		tend();
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

	it("sends nothing for a shadow stop, writing the would-be hold once a renewal", () => {
		const { root, clock, state, sent, tend } = mesh();
		state.stops = [stop("q", ["everything"], true)];
		tend();
		tend();
		clock.now += RENEW_MS;
		tend();
		expect(sent()).toEqual([]);
		const lines = readFileSync(join(root, "would-hold.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ stop: "q", to: ["#all"] });
	});

	it("leaves the holds to the session tending them, until its claim goes stale", () => {
		const { root, clock, state, sent, tend } = mesh();
		state.stops = [stop("q", ["quest:QEST-A"])];
		mkdirSync(join(root, "pineapple"), { recursive: true });
		writeFileSync(join(root, "pineapple", "claim"), "1");
		clock.now = Date.now();
		tend();
		expect(sent()).toEqual([]);
		clock.now = Date.now() + 3 * 60 * 1000;
		tend();
		expect(sent()).toHaveLength(1);
	});
});

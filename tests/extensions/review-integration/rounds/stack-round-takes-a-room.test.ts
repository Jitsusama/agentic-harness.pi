/**
 * A stack round's reviewers run on a room, as a council's do, when every
 * member lists a head the tip's tree holds: a room's reviewer checks out
 * one commit, the tip's, so a stack the tip doesn't hold whole stays here and
 * waits on this machine's bars, as does one whose brief a room's start
 * can't carry. The room is read again after the wait, so one taken out
 * of the config meanwhile sends the round back to the bars.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { councilStartsPath } from "../../../../extensions/review-integration/engine.ts";
import { roomFor } from "../../../../extensions/review-integration/tools/ask-room.ts";
import type { RosterRoom } from "../../../../extensions/review-integration/tools/ask-round.ts";
import {
	beginStackRound,
	type StackStartAsk,
	type StackStartReads,
	settleStackRoom,
} from "../../../../extensions/review-integration/tools/ask-stack.ts";
import type { ChangeRef } from "../../../../lib/core/review/index.ts";
import { MAX_ROOM_BRIEF_BYTES } from "../../../../lib/subagent/runpi/room-launch.ts";
import { askFunctions } from "./ask-source.ts";

/** Long enough past the last start that no spacing holds a round. */
const LONG_AGO_MS = 2 * 60 * 60_000;
/** How long a round may look before the test calls it held, under the test's own limit. */
const HELD_AFTER_MS = 3000;
/** The tip's head, which a room's reviewer checks out. */
const HEAD = "c".repeat(40);
/** Where the node's command lies, standing in for the system profile's. */
const MYCELIUM = "/run/node/bin/mycelium";

const tip: ChangeRef = {
	provider: "github",
	repo: { key: "github:Jitsusama/agentic-harness.pi" },
	id: "3",
	label: "Jitsusama/agentic-harness.pi#3",
};

let root: string;
const was: Record<string, string | undefined> = {};
const HOMES = ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"] as const;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "stack-room-"));
	for (const name of HOMES) {
		was[name] = process.env[name];
		process.env[name] = join(root, name);
	}
});

afterEach(() => {
	for (const name of HOMES) {
		const value = was[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

const linePath = () => join(dirname(councilStartsPath()), "line.json");

/**
 * A line whose last start was long ago, with rounds of a live process
 * waiting ahead, as rounds held by this machine's memory wait.
 */
function heldLine(ids: readonly string[]): void {
	const now = Date.now();
	mkdirSync(dirname(linePath()), { recursive: true });
	writeFileSync(
		linePath(),
		JSON.stringify({
			started: {
				at: new Date(now - LONG_AGO_MS).toISOString(),
				by: "A2VLJN",
				change: "o/r#0",
			},
			waiting: ids.map((id, at) => ({
				id,
				by: id,
				change: `o/r#${id}`,
				pid: process.pid,
				askedAt: new Date(now - LONG_AGO_MS + at).toISOString(),
				seenAt: new Date(now).toISOString(),
			})),
		}),
	);
}

/** The package config, naming the room `review` holds. */
function config(review: unknown): string {
	const path = join(root, "config.json");
	writeFileSync(path, JSON.stringify({ version: 1, sections: { review } }));
	return path;
}

/** This machine's bars, counting how often a start reads them. */
function bars(held: boolean): RosterRoom & { asked: () => number } {
	let asked = 0;
	return {
		short: async () => {
			asked += 1;
			return held
				? { said: "memory is short", readings: ["memory"], passable: false }
				: undefined;
		},
		startedUnjudged: () => undefined,
		asked: () => asked,
	};
}

/** The reads a round makes, its room from the config at `path`. */
function reads(path: string, here: RosterRoom): StackStartReads {
	return {
		roomOf: (change, head, harness) =>
			roomFor(change, head, harness, path, () => MYCELIUM),
		here,
	};
}

/** A stack round's start, its wait and then its room, as askStack takes them with nothing pushed meanwhile. */
async function stackRoundStart(ask: StackStartAsk, with_: StackStartReads) {
	return await settleStackRoom(await beginStackRound(ask, with_), ask, with_);
}

/** A stack round's start, every member's head held unless said. */
function asked(overrides: Partial<StackStartAsk> = {}): StackStartAsk {
	return {
		tip,
		head: HEAD,
		prompt: "Review this stack.",
		unheld: [],
		headless: [],
		harness: () => ({ root: "/pkg", entryLoads: ["/pkg/fence.ts"] }),
		signal: AbortSignal.timeout(HELD_AFTER_MS),
		...overrides,
	};
}

describe("a stack round with a room configured", () => {
	it("starts past this machine's bars when the tip holds every head, handing its reviewers the room at the tip's commit", async () => {
		heldLine(["memory", "cpu"]);
		const here = bars(true);

		const { start, room } = await stackRoundStart(
			asked(),
			reads(config({ room: { machine: "room-1" } }), here),
		);

		expect(start.cancelled, "started, not held").toBeUndefined();
		expect(here.asked(), "never read this machine's bars").toBe(0);
		expect(room?.place.machine).toBe("room-1");
		expect(room?.code).toEqual({ repo: "agentic-harness.pi", commit: HEAD });
		const line = JSON.parse(readFileSync(linePath(), "utf8"));
		expect(line.started.change).toBe(tip.label);
		expect(line.waiting.map((each: { id: string }) => each.id)).toEqual([
			"memory",
			"cpu",
		]);
		await start.release?.();
	});

	it("stays here and waits on the bars when the tip doesn't hold a member's head", async () => {
		const here = bars(false);

		const { start, room } = await stackRoundStart(
			asked({ unheld: ["feature-b"] }),
			reads(config({ room: { machine: "room-1" } }), here),
		);

		expect(start.cancelled).toBeUndefined();
		expect(room, "no room for a stack the tip doesn't hold").toBeUndefined();
		expect(here.asked(), "read this machine's bars").toBeGreaterThan(0);
		await start.release?.();
	});

	it("stays here and waits on the bars when a member lists no head", async () => {
		const here = bars(false);

		const { start, room } = await stackRoundStart(
			asked({ headless: ["feature-b"] }),
			reads(config({ room: { machine: "room-1" } }), here),
		);

		expect(start.cancelled).toBeUndefined();
		expect(
			room,
			"no room for a head nothing shows the tip holds",
		).toBeUndefined();
		expect(here.asked(), "read this machine's bars").toBeGreaterThan(0);
		await start.release?.();
	});

	it("stays here and waits on the bars when its brief is too large for a room", async () => {
		const here = bars(false);

		const { start, room } = await stackRoundStart(
			asked({ prompt: "a".repeat(MAX_ROOM_BRIEF_BYTES + 1) }),
			reads(config({ room: { machine: "room-1" } }), here),
		);

		expect(start.cancelled).toBeUndefined();
		expect(room, "no room for a brief it can't carry").toBeUndefined();
		expect(here.asked(), "read this machine's bars").toBeGreaterThan(0);
		await start.release?.();
	});

	it("goes back to the bars when the room is taken out of the config while it waits", async () => {
		const here = bars(false);
		const path = config({ room: { machine: "room-1" } });
		let looked = 0;
		const taken: StackStartReads = {
			roomOf: async (change, head, harness) => {
				const room = await roomFor(change, head, harness, path, () => MYCELIUM);
				looked += 1;
				// Gone from the config by the time the wait is over.
				if (looked === 1) config({});
				return room;
			},
			here,
		};

		const { start, room } = await stackRoundStart(asked(), taken);

		expect(looked, "read the room again after the wait").toBe(2);
		expect(start.cancelled).toBeUndefined();
		expect(room, "no room once the config names none").toBeUndefined();
		expect(here.asked(), "waited on this machine's bars").toBeGreaterThan(0);
		await start.release?.();
	});
});

describe("a stack round's reviewers", () => {
	it("go to the room its start chose, taking no start of their own", () => {
		const body = askFunctions().get("askStack") ?? "";

		expect(body).toContain("await beginStackRound(");
		expect(body).not.toContain("awaitRosterStart(");
		expect(body).toMatch(
			/deps\(tip\.change, tree\.path, watch, charters, undefined, room\)/,
		);
	});

	it("weigh the room again only once the stack is built again after the wait", () => {
		const body = askFunctions().get("askStack") ?? "";
		const rebuilt = body.indexOf("built = afterWait.rebuilt;");
		const settles = body.indexOf("await settleStackRoom(");

		expect(rebuilt, "the stack is built again after its wait").toBeGreaterThan(
			-1,
		);
		expect(settles, "after that rebuild").toBeGreaterThan(rebuilt);
		expect(body.slice(settles)).toMatch(/stackStartOf\(built, seat\.signal\)/);
	});

	it("wait for their start with the round's signal, on a room and on the bars alike", () => {
		const begin = askFunctions().get("beginStackRound") ?? "";
		const settle = askFunctions().get("settleStackRoom") ?? "";

		expect(begin.split("ask.signal,").length - 1).toBe(1);
		expect(settle.split("ask.signal,").length - 1).toBe(1);
	});
});

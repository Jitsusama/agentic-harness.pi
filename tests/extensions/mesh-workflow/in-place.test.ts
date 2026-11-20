/**
 * Moving in place: a pi its holder runs itself hands its window to the
 * join rather than closing it, and moves only once nobody has typed in
 * it for a while, resting when nobody stops.
 */
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type HandOver,
	handOverOf,
	hostedPresence,
	JOIN_SCRIPT,
} from "../../../extensions/mesh-workflow/in-place.ts";
import {
	createMoving,
	QUIET_BOUND_MS,
	QUIET_MS,
	QUIET_REST_MS,
} from "../../../extensions/mesh-workflow/moving.ts";
import type { Moving } from "../../../lib/mesh/moving.ts";

/** The flag that keeps node's module-type warning out of a window's join. */
const QUIET = "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON";

let folder: string;
let wake: string;
let again: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "in-place-"));
	wake = join(folder, "0d1e.wake");
	again = join(folder, "0d1e.again");
	writeFileSync(join(folder, "0d1e.json"), JSON.stringify({ pid: 4242 }));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

function facts(over: Partial<Parameters<typeof handOverOf>[0]> = {}) {
	return {
		env: { MYCELIUM_WAKE: wake, MYCELIUM_AGAIN: again },
		pid: 4242,
		args: ["--model", "opus"],
		session: "01a1",
		sessionFile: "/logs/01a1.jsonl",
		quiet: () => undefined,
		...over,
	};
}

describe("handing a window over", () => {
	it("names the join, then plain pi on its log, as what its holder starts next", () => {
		let quiet = 0;
		const over = handOverOf(
			facts({
				quiet: () => {
					quiet += 1;
				},
			}),
		);
		expect(over?.tell(), "told, with no why").toBeUndefined();
		expect(quiet, "telling alone leaves it drawing").toBe(0);
		over?.quiet();
		expect(JSON.parse(readFileSync(again, "utf8"))).toEqual([
			process.execPath,
			QUIET,
			JOIN_SCRIPT,
			"--session",
			"01a1",
			"--",
			"pi",
			"--session",
			"/logs/01a1.jsonl",
			"--model",
			"opus",
		]);
		expect(JSON.parse(readFileSync(wake, "utf8"))).toMatchObject({
			session: "01a1",
			move: true,
		});
		expect(quiet).toBe(1);
	});

	it("keeps a fenced session fenced should plain pi take its log back", () => {
		handOverOf(
			facts({
				env: {
					MYCELIUM_WAKE: wake,
					MYCELIUM_AGAIN: again,
					PI_SANDBOX: "fence",
				},
			}),
		)?.tell();
		const command: unknown = JSON.parse(readFileSync(again, "utf8"));
		expect(
			Array.isArray(command)
				? command.slice(command.indexOf("--") + 1).slice(0, 4)
				: command,
			"plain pi's words, after the join's, start in the fence",
		).toEqual(["env", "PI_SANDBOX=fence", "pi", "--session"]);
	});

	it("can't when no holder runs it itself", () => {
		expect(handOverOf(facts({ env: {} }))).toBeUndefined();
		expect(handOverOf(facts({ env: { MYCELIUM_WAKE: wake } }))).toBeUndefined();
		expect(handOverOf(facts({ pid: 7 })), "a shell between").toBeUndefined();
	});

	it("says why, leaving nothing named, when its holder can't be told", () => {
		mkdirSync(wake);
		let quiet = 0;
		const over = handOverOf(
			facts({
				quiet: () => {
					quiet += 1;
				},
			}),
		);

		expect(
			over?.tell(),
			"the move is called off, told which file failed and how",
		).toMatch(/couldn't be told the join: EISDIR.*wake/);
		expect(quiet, "not gone quiet, so its window still draws").toBe(0);
		expect(existsSync(again), "no join left for a later start").toBe(false);
	});

	it("takes back what it told, for a move called off after", () => {
		const over = handOverOf(facts());
		expect(over?.tell(), "told").toBeUndefined();
		expect(existsSync(again), "the join named first").toBe(true);
		over?.untell();
		expect(existsSync(again), "no join left for a later start").toBe(false);
		expect(existsSync(wake), "no wake into it either").toBe(false);
	});

	it("can't with no log, or with flags plain pi would drop", () => {
		expect(handOverOf(facts({ sessionFile: undefined }))).toBeUndefined();
		expect(handOverOf(facts({ args: ["--offline"] }))).toBeUndefined();
	});
});

describe("a hosted conversation's presence", () => {
	it("names the join as what a window opened on it runs", () => {
		expect(hostedPresence("work-attended", "01a1", "/logs/01a1.jsonl")).toEqual(
			{
				host: "work-attended",
				conversation: "01a1",
				view: [
					process.execPath,
					QUIET,
					JOIN_SCRIPT,
					"--view",
					"--session",
					"01a1",
					"--",
					"pi",
					"--session",
					"/logs/01a1.jsonl",
				],
			},
		);
	});

	it("keeps a fenced conversation fenced in the window that takes it back", () => {
		const { view } = hostedPresence(
			"work-attended",
			"01a1",
			"/logs/01a1.jsonl",
			{
				PI_SANDBOX: "fence",
				HOME: "/home/joel",
			},
		);
		expect(
			view === undefined ? view : view.slice(view.indexOf("--") + 1),
			"plain pi's words carry the fence, and nothing else of the env",
		).toEqual([
			"env",
			"PI_SANDBOX=fence",
			"pi",
			"--session",
			"/logs/01a1.jsonl",
		]);
	});

	it("names no words with no log for plain pi to take up", () => {
		expect(hostedPresence("work-attended", "01a1", undefined)).toEqual({
			host: "work-attended",
			conversation: "01a1",
		});
	});
});

interface Window {
	keyedAt: number;
	clock: number;
	moving: Moving | undefined;
	over: HandOver | undefined;
	readonly did: string[];
	readonly told: string[];
	readonly offs: string[];
	tick?: () => void;
}

/** How a window's hand-over goes: why its holder can't be told, or its note can't be written. */
interface Going {
	readonly untold?: string;
	readonly noteFails?: string;
}

function window(going: Going = {}): {
	at: Window;
	move: ReturnType<typeof createMoving>;
} {
	const at: Window = {
		keyedAt: Number.NEGATIVE_INFINITY,
		clock: Date.parse("2026-11-11T03:00:00.000Z"),
		moving: undefined,
		over: {
			tell: () => {
				at.did.push("tell");
				return going.untold;
			},
			untell: () => at.did.push("untell"),
			quiet: () => at.did.push("hand over"),
		},
		did: [],
		told: [],
		offs: [],
	};
	const move = createMoving({
		holds: () => undefined,
		hosted: () => false,
		moving: () => at.moving,
		setMoving: (now) => {
			at.moving = now;
		},
		calledOff: (off) => {
			at.moving = undefined;
			at.offs.push(off.why);
		},
		note: (to) => {
			if (going.noteFails !== undefined) throw new Error(going.noteFails);
			at.did.push(`note ${to}`);
		},
		handOver: () => at.over,
		keyedAt: () => at.keyedAt,
		tell: (text) => at.told.push(text),
		close: () => at.did.push("close"),
		now: () => new Date(at.clock),
		every: (_ms, look) => {
			at.tick = look;
			return () => {
				at.tick = undefined;
			};
		},
	});
	return { at, move };
}

/** Let `ms` pass, looking as the clock would. */
function pass(at: Window, ms: number): void {
	at.clock += ms;
	at.tick?.();
}

describe("moving in place", () => {
	it("hands its window over, telling nothing, once nobody has typed", () => {
		const { at, move } = window();
		move.move("attended");
		expect(at.did, "its holder told before the move is noted").toEqual([
			"tell",
			"note attended",
			"hand over",
			"close",
		]);
		expect(at.told).not.toContainEqual(expect.stringMatching(/Free now/));
	});

	it("waits out its person typing, and a key calls nothing off", () => {
		const { at, move } = window();
		at.keyedAt = at.clock;
		move.move("attended");
		expect(at.did).toEqual([]);
		expect(at.moving?.holds).toBe("its person typing");
		pass(at, 2_000);
		at.keyedAt = at.clock;
		move.typed();
		expect(at.moving?.to).toBe("attended");
		pass(at, QUIET_MS - 1);
		expect(at.did).toEqual([]);
		pass(at, 1);
		expect(at.did).toEqual(["tell", "note attended", "hand over", "close"]);
	});

	it("rests when nobody stops typing, then looks again", () => {
		const { at, move } = window();
		at.keyedAt = at.clock;
		move.move("background");
		for (let waited = 0; waited < QUIET_BOUND_MS; waited += 2_000) {
			at.keyedAt = at.clock;
			pass(at, 2_000);
		}
		expect(at.did).toEqual([]);
		expect(at.moving?.holds).toMatch(/^no quiet moment in its window/);
		pass(at, QUIET_REST_MS - 2_000);
		expect(at.did, "it still rests").toEqual([]);
		pass(at, 2_000);
		expect(at.did).toEqual(["tell", "note background", "hand over", "close"]);
	});

	it("stays open, saying why, when its holder can't be told", () => {
		const { at, move } = window({ untold: "the disk is full" });
		move.move("attended");
		expect(at.did, "neither noted nor closed").toEqual(["tell"]);
		expect(at.offs, "the why an asker outside reads").toEqual([
			"the disk is full",
		]);
		expect(at.told.at(-1)).toBe(
			"This session couldn't move to the attended host, so it stays open: the disk is full",
		);
	});

	it("takes back its holder's telling when its note can't be written", () => {
		const { at, move } = window({ noteFails: "the disk is full" });
		move.move("attended");
		expect(at.did, "told, then taken back, and not closed").toEqual([
			"tell",
			"untell",
		]);
		expect(at.offs, "the why an asker outside reads").toEqual([
			"its note couldn't be written: the disk is full",
		]);
		expect(at.told.at(-1)).toBe(
			"This session couldn't move to the attended host, so it stays open: the disk is full",
		);
	});

	it("closes its window, and typing calls it off, when it can't hand over", () => {
		const { at, move } = window();
		at.over = undefined;
		at.keyedAt = at.clock;
		move.move("attended");
		expect(at.did).toEqual(["note attended", "close"]);
		expect(at.told).toContain("Free now; moving to the attended host.");

		const other = window();
		other.at.over = undefined;
		other.at.moving = { to: "attended", since: "now", holds: "a run" };
		other.move.typed();
		expect(other.at.moving).toBeUndefined();
		expect(other.at.told.at(-1)).toMatch(/The move is off/);
	});
});

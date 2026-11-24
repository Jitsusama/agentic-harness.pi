/**
 * A stop's backstop ends the host from a thread beside its loop, so a loop
 * held on a CPU, which no timer of its own can interrupt, still ends short
 * of systemd's kill and says what it left unparked.
 */

import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backstopStop } from "../../../host/service/stop-backstop.ts";

const BACKSTOP = resolve(
	import.meta.dirname,
	"../../../host/service/stop-backstop.ts",
);

/** How long the backstop waits in these cases, in ms. */
const WITHIN_MS = 300;

/** How long a case's child may take before it counts as never ended. */
const CHILD_MS = 10_000;

/**
 * A host's stop in miniature: it arms the backstop, may tell it again what
 * is unparked or that the stop ended, then spins, as a loop held on a CPU
 * does, or idles once its stop ended.
 */
const child = `
import { backstopStop } from ${JSON.stringify(BACKSTOP)};
const [mode, file] = process.argv.slice(2);
const ids = mode === "parked" ? [] : ["a", "b"];
// The loop's wall clock ten minutes ahead of the thread's, as when the clock
// is stepped back between arming and the thread starting, or behind it, as
// when it is stepped forward.
const wallClock = Date.now;
if (mode === "stepped") Date.now = () => wallClock() + 600_000;
if (mode === "forward") Date.now = () => wallClock() - 600_000;
const backstop = backstopStop({ within: ${WITHIN_MS}, file, ids });
Date.now = wallClock;
if (mode === "moved") backstop.held(["b"]);
if (mode === "done") {
	backstop.done();
	// Long past the backstop, so a thread slow to start would still fire.
	setTimeout(() => process.exit(0), ${10 * WITHIN_MS});
} else {
	const until = Date.now() + ${CHILD_MS};
	while (Date.now() < until) {
		// Spinning, as a loop held by synchronous work is.
	}
	process.exit(3);
}
`;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stop-backstop-"));
	writeFileSync(join(dir, "child.mts"), child);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** How a run of the child ended, what it said, and how long it took. */
interface Ended {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly said: string;
	readonly took: number;
}

/** Run the child in `mode`, its mark at `file`. */
function run(mode: string, file: string): Promise<Ended> {
	const began = Date.now();
	// Without node's own warnings, so what it says is the backstop's alone.
	const ran = spawn(
		process.execPath,
		["--no-warnings", join(dir, "child.mts"), mode, file],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let said = "";
	ran.stderr.on("data", (chunk: Buffer) => {
		said += chunk.toString();
	});
	return new Promise((done) => {
		ran.on("close", (code, signal) =>
			done({ code, signal, said, took: Date.now() - began }),
		);
	});
}

/** How long the backstop's line says it waited, in ms. */
function waitedOf(ended: Ended): number {
	return Number(/after (-?\d+) ms/.exec(ended.said)?.[1]);
}

/** The mark a child left, as the next start reads it. */
function marked(file: string): unknown {
	return JSON.parse(readFileSync(file, "utf8"));
}

describe("backstopStop", () => {
	it("ends a host whose loop spins past it, naming what it left unparked", {
		timeout: 2 * CHILD_MS,
	}, async () => {
		const file = join(dir, "host", "not-parked.json");
		const ended = await run("spin", file);
		expect(ended.signal, `ended by its thread: ${ended.said}`).toBe("SIGKILL");
		expect(ended.took, "well short of its spin").toBeLessThan(CHILD_MS / 2);
		expect(ended.said, "the journal line").toMatch(
			/^pi-host: stopping after \d+ ms, its loop held past the 300 ms its thread allows, 2 not parked: a, b; ending the host from that thread\n$/,
		);
		expect(marked(file), "the mark the next start reads").toEqual({
			at: expect.any(Number),
			ids: ["a", "b"],
		});
		// Whole ms rounded down from both ends, so only a count past the
		// bound is sure to be its whole time (5BACCAC3's F113 on #2076).
		expect(
			waitedOf(ended),
			"counted from when it was armed, past its bound",
		).toBeGreaterThan(WITHIN_MS);
	});

	// F49: what is owed never passes what it was armed with.
	it("still ends within its bound when the wall clock steps back before its thread starts", {
		timeout: 2 * CHILD_MS,
	}, async () => {
		const ended = await run("stepped", join(dir, "not-parked.json"));
		expect(ended.signal, `ended by its thread: ${ended.said}`).toBe("SIGKILL");
		expect(ended.took, "well short of its spin").toBeLessThan(CHILD_MS / 2);
		expect(waitedOf(ended), "what it says it waited").toBeGreaterThanOrEqual(
			WITHIN_MS,
		);
		expect(waitedOf(ended)).toBeLessThan(CHILD_MS / 2);
	});

	// 5BACCAC3's F80 and F81 on #2076: a step forward never ends it early,
	// nor makes what it says it waited untrue.
	it("never ends early when the wall clock steps forward before its thread starts", {
		timeout: 2 * CHILD_MS,
	}, async () => {
		const ended = await run("forward", join(dir, "not-parked.json"));
		expect(ended.signal, `ended by its thread: ${ended.said}`).toBe("SIGKILL");
		expect(ended.took, "not before its time").toBeGreaterThanOrEqual(WITHIN_MS);
		expect(waitedOf(ended), "what it says it waited").toBeGreaterThan(
			WITHIN_MS,
		);
		expect(waitedOf(ended)).toBeLessThan(CHILD_MS / 2);
	});

	it("names what was unparked as last told, which the held loop can't update", {
		timeout: 2 * CHILD_MS,
	}, async () => {
		const file = join(dir, "not-parked.json");
		const ended = await run("moved", file);
		expect(ended.signal, `ended by its thread: ${ended.said}`).toBe("SIGKILL");
		expect(ended.said, "the one left").toMatch(/1 not parked: b;/);
		expect(marked(file), "the one left").toMatchObject({ ids: ["b"] });
	});

	it("leaves no mark when every conversation had parked", {
		timeout: 2 * CHILD_MS,
	}, async () => {
		const file = join(dir, "not-parked.json");
		const ended = await run("parked", file);
		expect(ended.signal, `ended by its thread: ${ended.said}`).toBe("SIGKILL");
		expect(ended.said, "none left").toMatch(/0 not parked;/);
		expect(existsSync(file), "no mark").toBe(false);
	});

	it("does nothing once its stop ended on the loop", {
		timeout: 2 * CHILD_MS,
	}, async () => {
		const file = join(dir, "not-parked.json");
		const ended = await run("done", file);
		expect(ended, "exits as it chose").toMatchObject({
			code: 0,
			signal: null,
			said: "",
		});
		expect(existsSync(file), "no mark").toBe(false);
	});

	it("says so when its thread can't start, leaving the stop to its loop", () => {
		const said = join(dir, "said");
		const fd = openSync(said, "w");
		try {
			// A symbol can't be handed to a thread, so its start throws.
			const unclonable: string[] = [Symbol("unclonable") as unknown as string];
			const backstop = backstopStop({
				within: 60_000,
				file: join(dir, "not-parked.json"),
				ids: unclonable,
				fd,
			});
			backstop.held(["a"]);
			backstop.done();
		} finally {
			closeSync(fd);
		}
		expect(readFileSync(said, "utf8")).toMatch(
			/^pi-host: couldn't arm the stop's backstop thread: .+; its loop's own bound is all that ends it\n$/,
		);
	});
});

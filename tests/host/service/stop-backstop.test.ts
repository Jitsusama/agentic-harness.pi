/**
 * A stop's backstop ends the host from a thread beside its loop, so a loop
 * held on a CPU, which no timer of its own can interrupt, still ends short
 * of systemd's kill and says what it left unparked.
 */

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
const backstop = backstopStop({ within: ${WITHIN_MS}, bound: 200, file, ids });
if (mode === "moved") backstop.held(["b"]);
if (mode === "done") {
	backstop.done();
	setTimeout(() => process.exit(0), ${3 * WITHIN_MS});
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
});

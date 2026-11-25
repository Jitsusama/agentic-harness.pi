/**
 * The host's threads run under a host started as module source, as its own
 * end-to-end runs start it with `--input-type=module`. A thread takes its
 * process's flags, so a program that reached node's modules through
 * `require` threw there: the stores' checkpoint thread died four times in
 * each such host and its stores went unchecked until they closed, and the
 * hold watch never started, all while every live host, started from its
 * file, ran them.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CHECKPOINTS = resolve(
	import.meta.dirname,
	"../../host/engine/checkpoints.ts",
);
const HOLD_WATCH = resolve(
	import.meta.dirname,
	"../../host/service/hold-watch.ts",
);

/** How long a child may take before it counts as never ended, in ms. */
const CHILD_MS = 20_000;

/** A program in fixtures/, as the source a host's end-to-end runs pass after -e. */
function fixture(name: string): string {
	return readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8");
}

/** A host's store in miniature, which says whether its checkpoint thread copied it back. */
const checkpointChild = fixture("checkpoint-as-source.mjs");

/** A host's loop held in miniature, which says what its hold watch said. */
const holdChild = fixture("hold-as-source.mjs");

/** The flag that kills every thread a child starts, as it starts. */
const NO_THREAD_STARTS = `--import=${resolve(import.meta.dirname, "fixtures", "no-thread-starts.mjs")}`;

/** What a child wrote and how it ended. */
interface Ended {
	readonly code: number | null;
	readonly out: string;
	readonly err: string;
	/** How it ended, for the failure's words, when its code says nothing. */
	readonly how: string;
}

/** The signal spawn's timeout sends, node's default. */
const TIMEOUT_SIGNAL = "SIGTERM";

/**
 * How a child ended, in words: a kill by spawn's timeout is a hang, any
 * other signal is said as itself, and where it was killed, what it had
 * written to `leftIn` so far, since the folder goes once the test ends.
 */
function howItEnded(
	code: number | null,
	signal: NodeJS.Signals | null,
	leftIn: string | undefined,
): string {
	if (signal === null) return `exited ${code}`;
	const killed =
		signal === TIMEOUT_SIGNAL
			? `killed by ${signal}, so it hung past ${CHILD_MS} ms`
			: `killed by ${signal}`;
	if (leftIn === undefined || !existsSync(leftIn)) return killed;
	return `${killed}, having said: ${readFileSync(leftIn, "utf8") || "nothing"}`;
}

/**
 * Run `source` as a host's end-to-end runs start one, as module source
 * after -e, with node's `flags` before it. `leftIn` names a file the
 * child writes as it goes, read into the failure's words if it is killed.
 */
function runAsSource(
	source: string,
	args: readonly string[],
	flags: readonly string[] = [],
	leftIn?: string,
): Promise<Ended> {
	const child = spawn(
		process.execPath,
		["--no-warnings", ...flags, "--input-type=module", "-e", source, ...args],
		{ stdio: ["ignore", "pipe", "pipe"], timeout: CHILD_MS },
	);
	let out = "";
	let err = "";
	child.stdout.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		err += chunk.toString();
	});
	return new Promise((done) => {
		child.on("close", (code, signal) =>
			done({
				code,
				out,
				err,
				how: howItEnded(code, signal, leftIn),
			}),
		);
	});
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "threads-as-source-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("the host's threads, under a host started as module source", () => {
	it("checkpoints a kept store off the thread rather than failing to start", {
		timeout: 2 * CHILD_MS,
	}, async () => {
		const store = join(dir, "durable.sqlite");
		const ended = await runAsSource(checkpointChild, [CHECKPOINTS, store]);
		expect(ended.code, `${ended.how}: ${ended.err}`).toBe(0);
		expect(
			JSON.parse(ended.out.trim()),
			"the thread copied the store back, reporting nothing",
		).toEqual({ checkpointed: store });
	});

	it("watches the loop and says how long it held", {
		timeout: 2 * CHILD_MS,
	}, async () => {
		const ended = await runAsSource(
			holdChild,
			[HOLD_WATCH, dir],
			[],
			join(dir, "said"),
		);
		expect(ended.code, `${ended.how}: ${ended.err}`).toBe(0);
		expect(ended.out, "the watch's line once the loop turned").toMatch(
			/the loop held /,
		);
		expect(
			ended.out,
			"the thread's inspector profiled the held main thread",
		).toMatch(/profiled the held loop's main thread/);
		expect(ended.out, "and kept the profile").toMatch(
			/kept the held loop's profile in /,
		);
	});

	it("says once, with where, that the hold watch's thread failed", {
		timeout: 2 * CHILD_MS,
	}, async () => {
		const ended = await runAsSource(
			holdChild,
			[HOLD_WATCH, dir],
			[NO_THREAD_STARTS],
			join(dir, "said"),
		);
		expect(ended.code, `${ended.how}: ${ended.err}`).toBe(0);
		const failed = ended.out.match(/the hold watch's thread failed/g) ?? [];
		expect(failed, `said once, in: ${ended.out}`).toHaveLength(1);
		expect(
			ended.out,
			"the line gives the thread's error and the stack that found it",
		).toMatch(
			/holds go unwatched: Error: no thread may start in this process\n\s+at .*no-thread-starts\.mjs/,
		);
		expect(ended.out, "and the watch said nothing else").not.toMatch(
			/the loop held /,
		);
	});
});

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
import { mkdtempSync, rmSync } from "node:fs";
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

/**
 * A host's store in miniature: opened as chord opens one, written past the
 * checkpointer's pages and kept, then the child says whether the thread
 * copied it back or reported a failure, whichever comes first.
 */
const checkpointChild = `
import { DatabaseSync } from "node:sqlite";
import { checkpointing } from ${JSON.stringify(CHECKPOINTS)};
const [store] = process.argv.slice(-1);
const db = new DatabaseSync(store);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA wal_autocheckpoint = 0");
db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY, record TEXT)");
const insert = db.prepare("INSERT INTO entry (record) VALUES (?)");
for (let row = 0; row < 40; row++) insert.run("x".repeat(4096));
const said = (answer) => {
	process.stdout.write(JSON.stringify(answer) + "\\n");
	process.exit(0);
};
const kept = checkpointing({
	every: 20,
	pages: 8,
	report: (error) => said({ reported: String(error) }),
	observe: (event) => {
		if (event.op === "checkpointed") said({ checkpointed: event.path });
	},
}).keep(store);
// Holds the process open until the thread answers; the test's own limit ends a silent one.
setInterval(() => kept, 1000);
`;

/**
 * A host's loop held in miniature: the watch armed, profiling into the
 * folder it is given, the loop spun past its hold and the profile's start,
 * then let go long enough for the thread to say how long it held.
 */
const holdChild = `
import { watchHolds } from ${JSON.stringify(HOLD_WATCH)};
const [folder] = process.argv.slice(-1);
const stop = watchHolds({
	fd: 1,
	every: 20,
	after: 200,
	still: 60_000,
	profile: { folder, after: 300, for: 200 },
});
// Time for the thread to start and see the loop move before it is held.
setTimeout(() => {
	const until = Date.now() + 1200;
	while (Date.now() < until) {
		// Held, as a loop doing synchronous work is.
	}
	// Time, once the loop turns again, for the thread to say the hold ended.
	setTimeout(() => {
		stop();
		process.exit(0);
	}, 600);
}, 300);
`;

/** What a child wrote and how it ended. */
interface Ended {
	readonly code: number | null;
	readonly out: string;
	readonly err: string;
}

/** Run `source` as a host's end-to-end runs start one, as module source after -e. */
function runAsSource(source: string, ...args: string[]): Promise<Ended> {
	const child = spawn(
		process.execPath,
		["--no-warnings", "--input-type=module", "-e", source, ...args],
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
		child.on("close", (code) => done({ code, out, err }));
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
		const ended = await runAsSource(checkpointChild, store);
		expect(ended.code, `ended: ${ended.err}`).toBe(0);
		expect(
			JSON.parse(ended.out.trim()),
			"the thread copied the store back, reporting nothing",
		).toEqual({ checkpointed: store });
	});

	it("watches the loop and says how long it held", {
		timeout: 2 * CHILD_MS,
	}, async () => {
		const ended = await runAsSource(holdChild, dir);
		expect(ended.code, `ended: ${ended.err}`).toBe(0);
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
});

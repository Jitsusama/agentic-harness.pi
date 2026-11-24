/**
 * Arriving with a session file in a form other than plain: a gzip held
 * to the most arriving unzips, and a form this harness can't read named
 * as likely newer than it.
 */

import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
	doneFileOf,
	readHandover,
	writeHandover,
} from "../../../../lib/internal/carry/handover.ts";
import { arrivals, fakeClock, SESSION, scratchOf } from "./support/arriving.ts";
import { folder, removeAll } from "./support/machines.ts";

const made: string[] = [];
afterEach(() => removeAll(made));

const { carried, arriveAt } = arrivals(made);

const MIB = 1024 * 1024;

/** A session file's text of exactly `bytes` bytes: its header, then one long line. */
function sessionOf(bytes: number): string {
	const line = `${JSON.stringify({ type: "session", id: SESSION, cwd: "/x" })}\n`;
	return `${line}${"m".repeat(bytes - line.length - 1)}\n`;
}

describe("arriving with a session file not in plain form", () => {
	it("places nothing from a gzipped session file that unzips past the most arriving unzips, saying why", async () => {
		const { from } = await carried(undefined, { largestFile: 1000 });
		// 3 MiB, which gzips to a few KiB, over a 1 MiB most.
		writeFileSync(
			join(from, `2026-11-07_${SESSION}.jsonl.gz`),
			gzipSync(sessionOf(3 * MIB)),
		);
		const home = folder(made, "arriving");

		const { whole, said, store } = await arriveAt(home, from, fakeClock(), [], {
			largestUnzipped: MIB,
		});

		expect(whole, "a session not placed is not whole").toBe(false);
		expect(said.find((line) => line.kind === "failed")).toEqual({
			kind: "failed",
			why: `2026-11-07_${SESSION}.jsonl.gz couldn't be placed: it unzips to more than 1 MiB, the most arriving unzips, so it wasn't unzipped further`,
		});
		expect(said.at(-1)).toEqual({ kind: "sessions", sessions: [] });
		expect(readdirSync(store), "nothing placed").toEqual([]);
		expect(
			readdirSync(join(scratchOf(from), "tmp")),
			"no part of it is left unzipped",
		).toEqual([]);
	});

	it("places a gzipped session file that unzips to just the most arriving unzips", async () => {
		const { from } = await carried(undefined, { largestFile: 1000 });
		writeFileSync(
			join(from, `2026-11-07_${SESSION}.jsonl.gz`),
			gzipSync(sessionOf(MIB)),
		);
		const home = folder(made, "arriving");

		const { said } = await arriveAt(home, from, fakeClock(), [], {
			largestUnzipped: MIB,
		});

		expect(said.at(-1)).toEqual({
			kind: "sessions",
			sessions: [{ id: SESSION, cwd: join(home, "src", "app") }],
		});
	});

	it("places nothing from a gzipped session file one byte past the most arriving unzips, leaving it to arrive again", async () => {
		const { from } = await carried(undefined, { largestFile: 1000 });
		const zipped = join(from, `2026-11-07_${SESSION}.jsonl.gz`);
		writeFileSync(zipped, gzipSync(sessionOf(MIB + 1)));
		const home = folder(made, "arriving");

		const { whole, said, store } = await arriveAt(home, from, fakeClock(), [], {
			largestUnzipped: MIB,
		});

		expect(whole, "a session not placed is not whole").toBe(false);
		expect(said.at(-1)).toEqual({ kind: "sessions", sessions: [] });
		expect(readdirSync(store), "nothing placed").toEqual([]);
		expect(existsSync(zipped), "the carried file stays to arrive again").toBe(
			true,
		);
	});

	it("places nothing from a session file in a form this harness can't read, saying it may be older", async () => {
		const { from } = await carried();
		const done = doneFileOf(from, SESSION);
		const handover = readHandover(done);
		if (handover?.sessionFile === undefined) throw new Error("none carried");
		const newer = `${handover.sessionFile}.zst`;
		renameSync(join(from, handover.sessionFile), join(from, newer));
		writeHandover(from, { ...handover, sessionFile: newer });
		const home = folder(made, "arriving");

		const { whole, said, store } = await arriveAt(home, from);

		expect(whole, "a session not placed is not whole").toBe(false);
		expect(said.find((line) => line.kind === "failed")).toEqual({
			kind: "failed",
			why: `2026-11-07_${SESSION}.jsonl.zst is in a form this machine's harness can't read, so it wasn't placed: this harness is likely older than the carrying machine's, and arriving again once it is updated places it.`,
		});
		expect(said.at(-1)).toEqual({ kind: "sessions", sessions: [] });
		expect(readdirSync(store), "nothing placed").toEqual([]);
	});
});

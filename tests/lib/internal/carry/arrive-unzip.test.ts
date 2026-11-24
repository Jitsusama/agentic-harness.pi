/**
 * Arriving with a session file in a form other than plain: a gzip held
 * to the most arriving unzips, and a form this harness can't read named
 * as likely newer than it.
 */

import { readdirSync, renameSync, writeFileSync } from "node:fs";
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

describe("arriving with a session file not in plain form", () => {
	it("places nothing from a gzipped session file that unzips past the most arriving unzips, saying why", async () => {
		const { from } = await carried(undefined, { largestFile: 1000 });
		const header = JSON.stringify({ type: "session", id: SESSION, cwd: "/x" });
		// 3 MiB of turns, which gzip to a few KiB, over a 1 MiB most.
		writeFileSync(
			join(from, `2026-11-07_${SESSION}.jsonl.gz`),
			gzipSync(`${header}\n${'{"type":"message"}\n'.repeat(3 * 55_189)}`),
		);
		const home = folder(made, "arriving");

		const { whole, said, store } = await arriveAt(home, from, fakeClock(), [], {
			largestUnzipped: 1024 * 1024,
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
		const line = `${JSON.stringify({ type: "session", id: SESSION, cwd: "/x" })}\n`;
		const text = `${line}${"m".repeat(1024 * 1024 - line.length - 1)}\n`;
		writeFileSync(join(from, `2026-11-07_${SESSION}.jsonl.gz`), gzipSync(text));
		const home = folder(made, "arriving");

		const { said } = await arriveAt(home, from, fakeClock(), [], {
			largestUnzipped: Buffer.byteLength(text),
		});

		expect(said.at(-1)).toEqual({
			kind: "sessions",
			sessions: [{ id: SESSION, cwd: join(home, "src", "app") }],
		});
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

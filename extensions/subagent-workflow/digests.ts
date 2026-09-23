/**
 * Digest finished fleet subagents before the sweep reclaims them.
 *
 * A subagent's event stream is the only record of what it did, turn by
 * turn, and the sweep deletes it once a run is a week old. Kept whole,
 * those streams would run past a gigabyte a month on a disk that is
 * already short of room, so they are reduced to a digest instead: every
 * turn's usage verbatim, tool calls and results by size and content
 * digest, and a digest of the final answer. Measured over 745 real
 * streams that is under one percent of their size, and every one of
 * them reconciles to its result's cost to the cent.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { digestEvents } from "../../lib/subagent/digest.ts";

/** What a digesting pass over the fleet runs did. */
export interface DigestOutcome {
	/** Digests written this pass, new or refreshed. */
	readonly written: number;
	/** Digests already current, left as they were. */
	readonly current: number;
	/**
	 * Runs holding a stream that could not be digested. The sweep must
	 * spare these, since their stream is still the only copy.
	 */
	readonly failed: ReadonlySet<string>;
}

const EVENTS = "events.ndjson";

/**
 * The whole event stream, rotations included, in order.
 *
 * The supervisor rotates the stream once it grows past a size, gzipping
 * older segments to numbered files with the highest number oldest. It
 * rotates between stdout chunks rather than between lines, so one event
 * can straddle two segments: they are joined before anything splits
 * them into lines. Reading the current segment alone lost the head of
 * 28 real streams and $486 of their cost.
 */
async function readEventStream(dir: string): Promise<string> {
	const segments: string[] = [];
	let highest = 0;
	while (existsSync(join(dir, `${EVENTS}.${highest + 1}.gz`))) highest += 1;
	for (let index = highest; index >= 1; index -= 1) {
		const compressed = await readFile(join(dir, `${EVENTS}.${index}.gz`));
		segments.push(gunzipSync(compressed).toString("utf8"));
	}
	const current = join(dir, EVENTS);
	if (existsSync(current)) segments.push(await readFile(current, "utf8"));
	return segments.join("");
}

/** The newest modification time across a stream's segments. */
async function streamModified(dir: string): Promise<number> {
	let newest = 0;
	for (const name of await readdir(dir)) {
		if (!name.startsWith(EVENTS)) continue;
		newest = Math.max(newest, (await stat(join(dir, name))).mtimeMs);
	}
	return newest;
}

async function readResult(dir: string): Promise<unknown> {
	const path = join(dir, "result.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		// A result cut short by a crash. The stream still digests; the
		// header says the result was unreadable rather than inventing one.
		return null;
	}
}

async function subdirectories(path: string): Promise<string[]> {
	if (!existsSync(path)) return [];
	const entries = await readdir(path, { withFileTypes: true });
	return entries.filter((entry) => entry.isDirectory()).map((e) => e.name);
}

/**
 * Digest every subagent whose stream exists and has changed since its
 * digest was written.
 *
 * Re-digesting on change rather than once is what keeps this correct
 * without knowing whether a run has finished: a live stream is digested
 * as it stands and digested again when it grows, and the last pass
 * before the sweep sees it whole.
 */
export async function digestFleetRuns(
	runs: string,
	digests: string,
): Promise<DigestOutcome> {
	let written = 0;
	let current = 0;
	const failed = new Set<string>();

	for (const runId of await subdirectories(runs)) {
		const reviewers = join(runs, runId, "reviewers");
		for (const id of await subdirectories(reviewers)) {
			const dir = join(reviewers, id);
			const target = join(digests, runId, `${id}.jsonl`);
			try {
				const modified = await streamModified(dir);
				if (modified === 0) continue;
				if (existsSync(target) && (await stat(target)).mtimeMs >= modified) {
					current += 1;
					continue;
				}
				const stream = await readEventStream(dir);
				const digest = digestEvents(stream.split("\n"));
				const result = await readResult(dir);
				const header = {
					kind: "header",
					runId,
					subagentId: id,
					answer: digest.answer,
					coverage: digest.coverage,
					result: resultSummary(result),
				};
				await mkdir(join(digests, runId), { recursive: true });
				await writeFile(
					target,
					`${[header, ...digest.records].map((r) => JSON.stringify(r)).join("\n")}\n`,
					"utf8",
				);
				written += 1;
			} catch {
				// Any failure here, a corrupt rotation or a disk that will
				// not take the write, leaves the stream as the only copy of
				// what the subagent did. Naming the run is what lets the
				// sweep spare it rather than delete it uncaptured.
				failed.add(runId);
			}
		}
	}

	return { written, current, failed };
}

/**
 * The part of a result worth keeping beside its digest: how it ended
 * and what it said it cost, verbatim. Null when there was none, which
 * is not the same as a result that reported nothing.
 */
function resultSummary(result: unknown): Record<string, unknown> | null {
	if (typeof result !== "object" || result === null) return null;
	const r = result as Record<string, unknown>;
	return {
		exitCode: r.exitCode ?? null,
		usage: r.usage ?? null,
		warnings: Array.isArray(r.warnings) ? r.warnings.length : 0,
	};
}

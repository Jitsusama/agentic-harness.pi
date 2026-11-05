/**
 * A round can tell when its first reviewer has begun answering.
 *
 * That moment is when the brief it wrote to the cache can be read by
 * the next reviewer, so the rest of a round waits for it. Read from
 * the event log the supervisor writes, because that is the one record
 * both the waiting and the detached runner keep.
 */

import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { firstResponseBegun } from "../../../lib/subagent/first-response.ts";

const line = (event: object) => `${JSON.stringify(event)}\n`;
const USER_START = line({ type: "message_start", message: { role: "user" } });
const ASSISTANT_START = line({
	type: "message_start",
	message: { role: "assistant" },
});

async function log(): Promise<string> {
	return join(
		await mkdtemp(join(tmpdir(), "first-response-")),
		"events.ndjson",
	);
}

describe("waiting for a run's first response", () => {
	it("sees the assistant's message start", async () => {
		const path = await log();
		await writeFile(path, `${USER_START}${ASSISTANT_START}`);

		expect(await firstResponseBegun(path, { withinMs: 1_000 })).toBe(true);
	});

	it("is not fooled by the brief going out", async () => {
		// The user's message starts before the model has read a word of it,
		// and a reviewer started then reads nothing from the cache.
		const path = await log();
		await writeFile(path, USER_START);

		expect(await firstResponseBegun(path, { withinMs: 300 })).toBe(false);
	});

	it("waits for a log that does not exist yet, then for the line", async () => {
		// The supervisor creates the log when the child first speaks, which
		// is after the round has started waiting.
		const path = await log();
		const waiting = firstResponseBegun(path, { withinMs: 5_000 });

		await writeFile(path, USER_START);
		await appendFile(path, ASSISTANT_START.slice(0, 10));
		await appendFile(path, ASSISTANT_START.slice(10));

		expect(await waiting).toBe(true);
	});

	it("gives up when the time runs out", async () => {
		const path = await log();
		const began = Date.now();

		expect(await firstResponseBegun(path, { withinMs: 300 })).toBe(false);
		expect(Date.now() - began).toBeLessThan(2_000);
	});

	it("stops waiting when the round is cancelled", async () => {
		const path = await log();
		const stop = new AbortController();
		const waiting = firstResponseBegun(path, {
			withinMs: 60_000,
			signal: stop.signal,
		});

		stop.abort();

		expect(await waiting).toBe(false);
	});
});

/**
 * A session's warming carry, written off the thread as a restart's
 * shutdown writes it: it reads back whole, readable by its owner alone,
 * with nothing left in the folder it was staged in.
 */

import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	readWarmingCarry,
	type WarmingCarry,
	writeWarmingCarryOff,
} from "../../../../lib/internal/cache/warming-carry.ts";

const OWNER_ONLY = 0o600;
const PERMISSION_BITS = 0o777;

let dir: string;
beforeEach(() => {
	dir = join(mkdtempSync(join(tmpdir(), "warming-carry-")), "warming");
});

const carry = (sessionId = "s1"): WarmingCarry => ({
	sessionId,
	payload: { messages: [{ role: "user", content: "go" }] },
	headers: { "anthropic-beta": "context-1m" },
	provider: "anthropic",
	modelId: "claude-opus-5-5",
	at: 1_000,
	refreshedAt: 2_000,
	warms: 1,
});

describe("a warming carry written off the thread", () => {
	it("reads back as it was written", async () => {
		await writeWarmingCarryOff(dir, carry());
		expect(readWarmingCarry(dir, "s1")).toEqual(carry());
	});

	it("is readable by its owner alone, in a folder only its owner can open", async () => {
		await writeWarmingCarryOff(dir, carry());
		const file = statSync(join(dir, "s1.json.gz")).mode & PERMISSION_BITS;
		expect(file, "the carry").toBe(OWNER_ONLY);
		expect(statSync(dir).mode & PERMISSION_BITS, "its folder").toBe(0o700);
	});

	it("leaves nothing staged once it is written", async () => {
		await writeWarmingCarryOff(dir, carry("s1"));
		await writeWarmingCarryOff(dir, carry("s2"));
		expect(readdirSync(dir).sort()).toEqual([
			".writing",
			"s1.json.gz",
			"s2.json.gz",
		]);
		expect(readdirSync(join(dir, ".writing"))).toEqual([]);
	});
});

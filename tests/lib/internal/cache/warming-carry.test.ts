/**
 * A session's warming carry, written off the thread as a restart's
 * shutdown writes it: it reads back whole, readable by its owner alone,
 * with nothing left in the folder it was staged in, unless what wrote
 * it let it go first; and read and its warms kept off the thread, as a
 * host warming it does.
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	addPendingWarm,
	addPendingWarmOff,
	readWarmingCarry,
	readWarmingCarryOff,
	takePendingWarms,
	type WarmingCarry,
	writeWarmingCarry,
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

	it("is put in place only while its writer still owns it", async () => {
		writeWarmingCarry(dir, { ...carry(), warms: 3 });
		const letGo = new AbortController();
		const kept = await writeWarmingCarryOff(
			dir,
			carry(),
			new AbortController().signal,
		);
		letGo.abort();
		const dropped = await writeWarmingCarryOff(
			dir,
			{ ...carry(), warms: 5 },
			letGo.signal,
		);
		expect([
			kept,
			dropped,
			readWarmingCarry(dir, "s1")?.warms,
			readdirSync(join(dir, ".writing")),
		]).toEqual([true, false, carry().warms, []]);
	});
});

describe("a warming carry read off the thread", () => {
	it("reads back as it was written", async () => {
		writeWarmingCarry(dir, carry());
		expect(await readWarmingCarryOff(dir, "s1")).toEqual(carry());
	});

	it("is nothing when none was kept", async () => {
		expect(await readWarmingCarryOff(dir, "s1")).toBeNull();
	});

	it("is nothing when its file won't unpack", async () => {
		writeWarmingCarry(dir, carry());
		writeFileSync(join(dir, "s1.json.gz"), "not gzip");
		expect(await readWarmingCarryOff(dir, "s1")).toBeNull();
	});

	it("is nothing when its file names another session", async () => {
		writeWarmingCarry(dir, carry("s2"));
		renameSync(join(dir, "s2.json.gz"), join(dir, "s1.json.gz"));
		expect(await readWarmingCarryOff(dir, "s1")).toBeNull();
	});

	// A host says a carry it couldn't read, rather than taking it for none.
	it("rejects when its file is there but can't be read", async () => {
		mkdirSync(join(dir, "s1.json.gz"), { recursive: true });
		await expect(readWarmingCarryOff(dir, "s1")).rejects.toMatchObject({
			code: "EISDIR",
		});
	});
});

describe("a parked warm kept off the thread", () => {
	it("is taken in turn with the warms kept on it", async () => {
		const pending = join(dir, "..", "warming-pending");
		addPendingWarm(pending, "s1", { warm: 2 });
		await addPendingWarmOff(pending, "s1", { warm: 3 });
		expect(takePendingWarms(pending, "s1")).toEqual([
			expect.objectContaining({ warm: 2 }),
			expect.objectContaining({ warm: 3 }),
		]);
	});

	it("is readable by its owner alone", async () => {
		const pending = join(dir, "..", "warming-pending");
		await addPendingWarmOff(pending, "s1", { warm: 2 });
		const [file = ""] = readdirSync(pending);
		expect(statSync(join(pending, file)).mode & PERMISSION_BITS).toBe(
			OWNER_ONLY,
		);
	});
});

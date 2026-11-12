/**
 * Warming a parked conversation's cache from its carry: the host takes
 * on the schedule the session's own warming kept, 54 minutes after the
 * entry was last refreshed and at most four warms in all, and records
 * each warm for the session's next start. Fake timers stand in for the
 * hours; the carries are real files.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	parkedWarming,
	type WarmSent,
} from "../../../host/engine/parked-warming.ts";
import {
	readWarmingCarry,
	takePendingWarms,
	type WarmingCarry,
	writeWarmingCarry,
} from "../../../lib/internal/warming-carry.ts";
import { WRITING } from "../../../lib/internal/write-whole.ts";

const MINUTE = 60_000;
const WARM_EVERY = 54 * MINUTE;
const START = Date.parse("2026-11-12T19:00:00Z");

/** A one-hour request, as pi builds it for Opus 5.5. */
const payload = {
	model: "claude-opus-5-5",
	max_tokens: 128_000,
	system: [
		{
			type: "text",
			text: "You are pi.",
			cache_control: { type: "ephemeral", ttl: "1h" },
		},
	],
	messages: [{ role: "user", content: "go" }],
};

let carries: string;
let pending: string;

beforeEach(() => {
	vi.useFakeTimers({ now: START });
	const root = mkdtempSync(join(tmpdir(), "parked-warming-"));
	carries = join(root, "warming");
	pending = join(root, "warming-pending");
});
afterEach(() => {
	vi.useRealTimers();
	rmSync(join(carries, ".."), { recursive: true, force: true });
});

/** A carry as a session's shutdown wrote it, refreshed `ago` before now. */
function parkedCarry(
	fields: Partial<WarmingCarry> = {},
	ago = 0,
): WarmingCarry {
	const carry: WarmingCarry = {
		sessionId: "s2",
		payload,
		headers: { "pi-session-id": "s2" },
		provider: "anthropic",
		modelId: "claude-opus-5-5",
		at: Date.now() - ago,
		refreshedAt: Date.now() - ago,
		warms: 0,
		...fields,
	};
	writeWarmingCarry(carries, carry);
	return carry;
}

/** A warm's reply: the prompt read from cache, `cacheWrite` written. */
function reply(cacheWrite = 0): WarmSent {
	return {
		ok: true,
		message: {
			provider: "anthropic",
			model: "claude-opus-5-5",
			usage: {
				input: 3,
				output: 1,
				cacheRead: 188_000,
				cacheWrite,
				totalTokens: 188_004 + cacheWrite,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0.0376,
					cacheWrite: cacheWrite * 0.000008,
					total: 0.0376 + cacheWrite * 0.000008,
				},
			},
		},
	};
}

function warmer(
	options: {
		send?: (carry: WarmingCarry) => Promise<WarmSent>;
		enabled?: boolean;
	} = {},
) {
	const sent: WarmingCarry[] = [];
	const report = vi.fn();
	const warming = parkedWarming({
		carries,
		pending,
		send: async (carry) => {
			sent.push(carry);
			return (options.send ?? (async () => reply()))(carry);
		},
		enabled: async () => options.enabled ?? true,
		report,
	});
	return { warming, sent, report };
}

const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("warming a parked conversation", () => {
	it("warms 54 minutes after its entry was last refreshed, and records the warm", async () => {
		parkedCarry({ warms: 1 });
		const { warming, sent } = warmer();

		warming.start("s2");
		await wait(WARM_EVERY - 1);
		expect(sent).toHaveLength(0);
		await wait(1);

		expect(sent.map((carry) => carry.payload)).toEqual([payload]);
		expect(readWarmingCarry(carries, "s2")).toMatchObject({
			refreshedAt: START + WARM_EVERY,
			warms: 2,
		});
		expect(takePendingWarms(pending, "s2")).toEqual([
			expect.objectContaining({
				model: "claude-opus-5-5",
				usage: expect.objectContaining({ cacheRead: 188_000 }),
				sentAt: START + WARM_EVERY,
				parked: true,
			}),
		]);
	});

	it("takes the schedule up from the carry after a host restart", async () => {
		parkedCarry({ warms: 1 }, 30 * MINUTE);
		const { warming, sent } = warmer();

		warming.start("s2");
		await wait(24 * MINUTE - 1);
		expect(sent).toHaveLength(0);
		await wait(1);

		expect(sent).toHaveLength(1);
	});

	it("stops at four warms in all, counting the session's own", async () => {
		parkedCarry({ warms: 1 });
		const { warming, sent } = warmer();

		warming.start("s2");
		await wait(10 * WARM_EVERY);

		expect([sent.length, readWarmingCarry(carries, "s2")?.warms]).toEqual([
			3, 4,
		]);
	});

	it("stops at the first warm that wrote more than 2,000 tokens", async () => {
		parkedCarry();
		const { warming, sent } = warmer({ send: async () => reply(150_000) });

		warming.start("s2");
		await wait(10 * WARM_EVERY);

		expect(sent).toHaveLength(1);
		expect(takePendingWarms(pending, "s2")).toHaveLength(1);
	});

	it("tries a failed warm once more, then stops", async () => {
		parkedCarry();
		const { warming, sent, report } = warmer({
			send: async () => ({ ok: false, reason: "overloaded" }),
		});

		warming.start("s2");
		await wait(10 * WARM_EVERY);

		expect(sent).toHaveLength(2);
		expect(readWarmingCarry(carries, "s2")?.warms).toBe(0);
		expect(report).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringMatching(/overloaded/) }),
		);
	});

	it("writes nothing for a warm still out when the conversation wakes", async () => {
		parkedCarry({ warms: 1 });
		let answer: ((sent: WarmSent) => void) | undefined;
		const { warming, sent } = warmer({
			send: () =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		});

		warming.start("s2");
		await wait(WARM_EVERY);
		expect(warming.inFlight()).toBe(1);
		warming.stop("s2");
		answer?.(reply());
		await wait(10 * WARM_EVERY);

		expect([
			sent.length,
			warming.inFlight(),
			readWarmingCarry(carries, "s2")?.warms,
			takePendingWarms(pending, "s2").length,
		]).toEqual([1, 0, 1, 0]);
	});

	it("stops when the carry is taken, as a session starting takes it", async () => {
		parkedCarry();
		const { warming, sent } = warmer();

		warming.start("s2");
		rmSync(carries, { recursive: true, force: true });
		await wait(10 * WARM_EVERY);

		expect(sent).toHaveLength(0);
	});

	it("warms nothing while warming is switched off", async () => {
		parkedCarry();
		const { warming, sent } = warmer({ enabled: false });

		warming.start("s2");
		await wait(10 * WARM_EVERY);

		expect(sent).toHaveLength(0);
	});

	it("warms nothing for a carry that asked for no hour's cache", async () => {
		parkedCarry({
			payload: {
				...payload,
				system: [{ type: "text", text: "You are pi." }],
			},
		});
		const { warming, sent } = warmer();

		warming.start("s2");
		await wait(10 * WARM_EVERY);

		expect(sent).toHaveLength(0);
	});

	it("warms nothing once the entry it would warm has expired", async () => {
		parkedCarry({}, 61 * MINUTE);
		const { warming, sent } = warmer();

		warming.start("s2");
		await wait(10 * WARM_EVERY);

		expect(sent).toHaveLength(0);
	});

	it("warms nothing with no carry", async () => {
		const { warming, sent, report } = warmer();

		warming.start("s2");
		await wait(10 * WARM_EVERY);

		expect([sent.length, report.mock.calls.length]).toEqual([0, 0]);
	});

	it("writes the carry whole, readable by its owner alone", async () => {
		parkedCarry({ warms: 1 });
		const { warming } = warmer();

		warming.start("s2");
		await wait(WARM_EVERY);

		expect([
			readdirSync(carries).sort(),
			readdirSync(join(carries, WRITING)),
			statSync(join(carries, "s2.json.gz")).mode & 0o777,
		]).toEqual([[WRITING, "s2.json.gz"], [], 0o600]);
	});
});

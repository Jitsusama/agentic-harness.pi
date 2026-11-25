import { describe, expect, it } from "vitest";
import type { MemoryAnswer } from "../../host/service/protocol.ts";
import { askedOf, describeMemory } from "../../scripts/host-memory.ts";

const MIB = 1024 * 1024;
const AT = "2026-11-24T08:00:00.000Z";
const ONE = "01a1cf4a-a681-7237-bce7-2ce6dbc70547";
const TWO = "01a1ccd0-1fc8-7057-8e8c-4577817aa50d";
const THREE = "01a1f00d-0000-7000-8000-000000000001";

const host: MemoryAnswer["host"] = {
	key: "work-background",
	owner: { pid: 1200, startedAt: 1 },
};

/** A conversation whose child said `heap` MiB and was read at `pss` MiB. */
function inChild(sessionId: string, pss: number, heap: number) {
	return {
		sessionId,
		state: "idle" as const,
		pss: pss * MIB,
		heap: { used: heap * MIB, limit: 4096 * MIB, at: AT },
	};
}

describe("a host's memory, described", () => {
	it("gives the host's own, then each conversation's, with the children's median and total", () => {
		const lines = describeMemory("background", {
			host,
			own: {
				pss: 150 * MIB,
				heap: { used: 60 * MIB, limit: 4096 * MIB, at: AT },
			},
			// Out of order, and 90 MiB in bytes sorts last as text: the median
			// is 200 only when the readings are sorted as numbers.
			sessions: [
				inChild(THREE, 600, 300),
				inChild(ONE, 90, 50),
				inChild(TWO, 200, 90),
			],
		});

		expect(lines[0]).toBe(
			"background: host Pss 150 MiB, heap 60 of 4096 MiB; a child's Pss read for 3 of 3 conversations, median 200 MiB, total 890 MiB",
		);
		expect(lines[2]).toMatch(
			new RegExp(`^ {2}Pss 90 MiB +heap 50 of 4096 MiB +${AT} +idle +${ONE}$`),
		);
		expect(lines).toHaveLength(4);
	});

	it("takes an even count's median between its middle two", () => {
		const [said] = describeMemory("attended", {
			host,
			own: {},
			sessions: [inChild(ONE, 100, 50), inChild(TWO, 200, 90)],
		});

		expect(said).toContain(", median 150 MiB, total 300 MiB");
	});

	it("says unread, never 0, where the host took no reading, and leaves those out of the children's", () => {
		const lines = describeMemory("attended", {
			host,
			own: {},
			sessions: [{ sessionId: ONE, state: "parked" }, inChild(TWO, 200, 90)],
		});

		expect(lines[0]).toBe(
			"attended: host Pss unread, heap unread; a child's Pss read for 1 of 2 conversations, median 200 MiB, total 200 MiB",
		);
		expect(lines[1]).toMatch(
			new RegExp(`^ {2}Pss unread +heap unread +parked +${ONE}$`),
		);
	});

	it("gives each of a process's own spaces, largest first, under its line", () => {
		const lines = describeMemory(`background child ${ONE}`, {
			host,
			own: {
				pss: 270 * MIB,
				heap: {
					used: 168 * MIB,
					limit: 4096 * MIB,
					at: AT,
					spaces: [
						{ name: "code_space", used: 9 * MIB, size: 10 * MIB },
						{ name: "old_space", used: 150 * MIB, size: 160 * MIB },
						{ name: "large_object_space", used: 7 * MIB, size: 7 * MIB },
					],
					external: 12 * MIB,
					arrayBuffers: 3 * MIB,
				},
			},
			sessions: [{ sessionId: ONE, state: "busy" }],
		});

		expect(lines[1]).toBe(
			"  spaces: old_space 150 of 160 MiB, code_space 9 of 10 MiB, large_object_space 7 of 7 MiB; external 12 MiB, array buffers 3 MiB",
		);
		expect(lines).toHaveLength(3);
	});

	it("reads a host's kind, or a kind and a conversation's id, and nothing else", () => {
		expect(askedOf("background")).toEqual({ kind: "background" });
		expect(askedOf(`attended:${ONE}`)).toEqual({
			kind: "attended",
			session: ONE,
		});
		expect(askedOf("elsewhere"), "no such kind").toBeUndefined();
		expect(askedOf("background:../x"), "no path for an id").toBeUndefined();
		expect(askedOf(`background:${ONE}:x`)).toBeUndefined();
	});

	it("says no child's Pss was read when none was", () => {
		const [said] = describeMemory("attended", {
			host,
			own: { pss: 80 * MIB },
			sessions: [{ sessionId: ONE, state: "parked" }],
		});

		expect(said).toBe(
			"attended: host Pss 80 MiB, heap unread; no child's Pss read",
		);
	});
});

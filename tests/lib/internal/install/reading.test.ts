import { describe, expect, it } from "vitest";
import { sharedReading } from "../../../../lib/internal/install/reading.ts";

const AGE = 600_000;

function counted(maxAgeMs?: number) {
	let time = 0;
	let reads = 0;
	const reading = sharedReading<string, number>(
		() => {
			reads += 1;
			return reads;
		},
		{ maxAgeMs, now: () => time },
	);
	return {
		reading,
		advance: (ms: number) => {
			time += ms;
		},
		reads: () => reads,
	};
}

// A host runs every conversation through one load of the install check,
// and each conversation read the install again: a soak of twelve spent
// 1.9 s of the host's one loop parsing the same pnpm record (13 November).
describe("a reading every conversation of one load shares", () => {
	it("is read once for every caller inside its age", () => {
		const { reading, advance, reads } = counted(AGE);
		reading();
		advance(AGE - 1);
		expect(reading(), "the second caller's answer").toBe(1);
		expect(reads(), "readings taken").toBe(1);
	});

	it("is read again once it is older than its age", () => {
		const { reading, advance, reads } = counted(AGE);
		reading();
		advance(AGE);
		expect(reading(), "the answer after its age").toBe(2);
		expect(reads(), "readings taken").toBe(2);
	});

	it("is read again for a new key, and kept for it", () => {
		const { reading, reads } = counted();
		reading("aaa");
		expect(reading("bbb"), "the answer for a new key").toBe(2);
		expect(reading("bbb"), "the answer for that key again").toBe(2);
		expect(reads(), "readings taken").toBe(2);
	});

	it("gives a caller naming no key whichever reading stands", () => {
		const { reading, reads } = counted();
		reading();
		reading("bbb");
		expect(reading(), "the answer for no key").toBe(2);
		expect(reads(), "readings taken").toBe(2);
	});

	it("keeps a reading with no age for as long as its key stands", () => {
		const { reading, advance, reads } = counted();
		reading();
		advance(10 * AGE);
		reading();
		expect(reads(), "readings taken").toBe(1);
	});
});

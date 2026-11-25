/** A warm spare child: warmed before it is wanted, taken or left, never both. */
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isSpareSlot,
	type SpareWait,
	spareMarks,
	spareUntilTaken,
	takeSpare,
	warmVersion,
} from "../../../host/service/spare.ts";
import { until } from "../../support/until.ts";

const MB = 1024 * 1024;
let folder: string;
let slotFile: string;
let said: string[];

beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), "spare-"));
	slotFile = join(folder, "a0000000-0000-4000-8000-000000000001.json");
	await writeFile(slotFile, JSON.stringify({ spare: true }));
	said = [];
});

afterEach(async () => {
	await rm(folder, { recursive: true, force: true });
});

/** A wait that looks often, so a test settles in milliseconds. */
function waitOf(overrides: Partial<SpareWait> = {}): SpareWait {
	return {
		slotFile,
		warm: async () => undefined,
		moved: async () => undefined,
		size: () => 100 * MB,
		report: (line) => said.push(line),
		lookMs: 20,
		slotLookMs: 5,
		takeWithinMs: 200,
		...overrides,
	};
}

/** Resolve once `file` is there, as a supervisor sees the spare warm. */
async function written(file: string): Promise<void> {
	await until(`${file} to be written`, () => existsSync(file));
}

/** Write the slot as the supervisor does: aside, then renamed into place. */
async function name(held: object): Promise<void> {
	const aside = `${slotFile}.aside`;
	await writeFile(aside, JSON.stringify(held));
	await rename(aside, slotFile);
}

describe("a spare's slot", () => {
	it("is a spare's only while it holds the spare's mark", async () => {
		expect(
			isSpareSlot(slotFile),
			"a slot with the spare's mark is a spare's",
		).toBe(true);
		await name({});
		expect(isSpareSlot(slotFile), "a slot without the mark is no spare's").toBe(
			false,
		);
		await name({ spare: false });
		expect(
			isSpareSlot(slotFile),
			"a slot marked spare: false is no spare's",
		).toBe(false);
		await rm(slotFile);
		expect(isSpareSlot(slotFile), "a slot that is gone is no spare's").toBe(
			false,
		);
	});
});

describe("a warm spare", () => {
	it("warms before it says it is warm, and says what it holds once warm", async () => {
		let warmed = false;
		const marks = spareMarks(slotFile);
		const waiting = spareUntilTaken(
			waitOf({
				warm: async () => {
					expect(existsSync(marks.warm), `${marks.warm} isn't there`).toBe(
						false,
					);
					warmed = true;
				},
			}),
		);
		await written(marks.warm);
		expect(warmed, "the spare warmed before its warm mark was written").toBe(
			true,
		);
		expect(said).toEqual([
			expect.stringMatching(
				/^A warm spare: warmed in \d+\.\d s, holding 100 MB$/,
			),
		]);
		expect(await takeSpare(marks), "a warm spare is taken").toBe(true);
		await name({});
		await expect(waiting).resolves.toEqual({ taken: true });
	});

	it("starts as what its slot names once taken", async () => {
		const marks = spareMarks(slotFile);
		const waiting = spareUntilTaken(waitOf());
		await written(marks.warm);
		expect(await takeSpare(marks), "a warm spare is taken").toBe(true);
		expect(existsSync(marks.warm), `${marks.warm} isn't there`).toBe(false);
		expect(existsSync(marks.taken), `${marks.taken} is there`).toBe(true);
		await name({ session: { sessionId: "x" } });
		await expect(waiting).resolves.toEqual({ taken: true });
	});

	it("leaves once its install moves, and can no longer be taken", async () => {
		const marks = spareMarks(slotFile);
		const waiting = spareUntilTaken(
			waitOf({ moved: async () => "the install changes the host's own code" }),
		);
		await expect(waiting).resolves.toEqual({
			left: "the install changes the host's own code",
		});
		expect(existsSync(marks.warm), `${marks.warm} isn't there`).toBe(false);
		expect(await takeSpare(marks), "a spare that left is not taken").toBe(
			false,
		);
	});

	it("leaves once it has waited its time untaken, and can no longer be taken", async () => {
		const marks = spareMarks(slotFile);
		const waiting = spareUntilTaken(waitOf({ untakenWithinMs: 60 }));
		await expect(waiting).resolves.toEqual({
			left: expect.stringMatching(
				/^it waited \d+ s untaken, so a fresh one replaces it$/,
			),
		});
		expect(existsSync(marks.warm), "its warm mark outlived its leave").toBe(
			false,
		);
		expect(await takeSpare(marks), "a take landed on a spare gone").toBe(false);
	});

	it("stays for a take that landed before its leave", async () => {
		const marks = spareMarks(slotFile);
		let moved = false;
		const waiting = spareUntilTaken(
			waitOf({
				moved: async () => (moved ? "its install moved" : undefined),
				// Well past the wait below, so a loaded machine's slow name
				// isn't taken for a take that named nothing.
				takeWithinMs: 5_000,
			}),
		);
		await written(marks.warm);
		expect(
			await takeSpare(marks),
			"a take that landed before the leave is kept",
		).toBe(true);
		moved = true;
		// Past several of its looks, so a leave would have landed by now.
		await new Promise((resolve) => setTimeout(resolve, 80));
		await name({});
		await expect(waiting).resolves.toEqual({ taken: true });
	});

	it("stays for a take that lands while it decides to leave", async () => {
		const marks = spareMarks(slotFile);
		let took = false;
		const waiting = spareUntilTaken(
			waitOf({
				// The take lands between the spare's look at its marks and its
				// leave, the one race its leave settles on its own. Unmoved
				// until warm, as its look before the warm mark would leave.
				moved: async () => {
					if (!existsSync(marks.warm)) return undefined;
					if (!took) took = await takeSpare(marks);
					return "its install moved";
				},
			}),
		);
		// The taken mark is there once the rename lands, a moment before the
		// take that made it hears so.
		await vi.waitFor(() =>
			expect(
				took,
				"the take that landed while it decided to leave is kept",
			).toBe(true),
		);
		expect(existsSync(marks.taken), `${marks.taken} is there`).toBe(true);
		await name({});
		await expect(waiting).resolves.toEqual({ taken: true });
	});

	it("leaves, never warm, when its install moves during its warm", async () => {
		let moved = false;
		const waiting = spareUntilTaken(
			waitOf({
				warm: async () => {
					moved = true;
				},
				moved: async () => (moved ? "its install moved" : undefined),
				lookMs: 60_000,
			}),
		);
		await expect(waiting).resolves.toEqual({ left: "its install moved" });
		expect(
			existsSync(spareMarks(slotFile).warm),
			`${spareMarks(slotFile).warm} isn't there`,
		).toBe(false);
	});

	it("says in its warm mark the version it runs, for a take to judge", async () => {
		const marks = spareMarks(slotFile);
		expect(await warmVersion(marks), "before it is warm").toBeUndefined();
		const waiting = spareUntilTaken(
			waitOf({ version: "/install/versions/one" }),
		);
		await written(marks.warm);
		expect(await warmVersion(marks)).toBe("/install/versions/one");
		expect(
			await takeSpare(marks),
			"a spare running its install's version is taken",
		).toBe(true);
		expect(await warmVersion(marks), "once taken").toBeUndefined();
		await name({});
		await expect(waiting).resolves.toEqual({ taken: true });
	});

	it("leaves a take that names nothing within its time", async () => {
		const marks = spareMarks(slotFile);
		const waiting = spareUntilTaken(waitOf({ takeWithinMs: 30 }));
		await written(marks.warm);
		expect(await takeSpare(marks), "a warm spare is taken").toBe(true);
		await expect(waiting).resolves.toEqual({
			left: "it was taken, but its slot named nothing within 0.03 s",
		});
	});

	it("leaves once it holds more than a spare may, before or after it is warm", async () => {
		const tooBig = spareUntilTaken(waitOf({ size: () => 250 * MB }));
		await expect(tooBig).resolves.toEqual({
			left: "it holds 250 MB, past the 200 MB a spare may",
		});
		expect(
			existsSync(spareMarks(slotFile).warm),
			`${spareMarks(slotFile).warm} isn't there`,
		).toBe(false);
		let held = 100 * MB;
		const growing = spareUntilTaken(waitOf({ size: () => held }));
		await written(spareMarks(slotFile).warm);
		held = 201 * MB;
		await expect(growing).resolves.toEqual({
			left: "it holds 201 MB, past the 200 MB a spare may",
		});
	});

	it("reads what it holds once after its warm, for its report and its cap alike", async () => {
		let reads = 0;
		const spare = spareUntilTaken(
			waitOf({
				size: () => {
					reads += 1;
					return 100 * MB;
				},
				lookMs: 60_000,
			}),
		);
		await written(spareMarks(slotFile).warm);
		expect(reads).toBe(1);
		await name({ sessionId: "s1" });
		await expect(spare).resolves.toEqual({ taken: true });
	});

	// A default parameter fills an undefined argument, so a size that came
	// back unread used to be read, and collected, a second time.
	it("reads an unread size once after its warm too", async () => {
		let reads = 0;
		const spare = spareUntilTaken(
			waitOf({
				size: () => {
					reads += 1;
					return undefined;
				},
				lookMs: 60_000,
			}),
		);
		await written(spareMarks(slotFile).warm);
		expect(reads).toBe(1);
		await name({ sessionId: "s1" });
		await expect(spare).resolves.toEqual({ taken: true });
	});

	it("judges its cap by the figure its report gave", async () => {
		const sizes = [250 * MB, 100 * MB];
		const reports: string[] = [];
		const spare = spareUntilTaken(
			waitOf({
				size: () => sizes.shift(),
				report: (line: string) => reports.push(line),
			}),
		);

		await expect(spare).resolves.toEqual({
			left: "it holds 250 MB, past the 200 MB a spare may",
		});
		expect(reports.join("\n")).toContain("holding 250 MB");
	});

	it("leaves once its slot is cleared, as a host does once its unit has gone", async () => {
		const marks = spareMarks(slotFile);
		const waiting = spareUntilTaken(waitOf());
		await written(marks.warm);
		await rm(folder, { recursive: true, force: true });
		await expect(waiting).resolves.toEqual({ left: "its slot was cleared" });
	});

	it("leaves, never warm, when its warm fails", async () => {
		const waiting = spareUntilTaken(
			waitOf({
				warm: () => Promise.reject(new Error("no pi at the install")),
			}),
		);
		await expect(waiting).resolves.toEqual({
			left: "its warm failed: no pi at the install",
		});
		expect(
			existsSync(spareMarks(slotFile).warm),
			`${spareMarks(slotFile).warm} isn't there`,
		).toBe(false);
		expect(said).toEqual([]);
	});
});

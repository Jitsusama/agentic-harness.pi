/** A warm spare child: warmed before it is wanted, taken or left, never both. */
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isSpareSlot,
	type SpareWait,
	spareMarks,
	spareUntilTaken,
	takeSpare,
} from "../../../host/service/spare.ts";

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
async function until(file: string): Promise<void> {
	for (let tries = 0; tries < 400 && !existsSync(file); tries += 1)
		// A short look again, the test's only wait on the spare's own loop.
		await new Promise((resolve) => setTimeout(resolve, 5));
	if (!existsSync(file)) throw new Error(`${file} never came`);
}

/** Write the slot as the supervisor does: aside, then renamed into place. */
async function name(held: object): Promise<void> {
	const aside = `${slotFile}.aside`;
	await writeFile(aside, JSON.stringify(held));
	await rename(aside, slotFile);
}

describe("a spare's slot", () => {
	it("is a spare's only while it holds the spare's mark", async () => {
		expect(isSpareSlot(slotFile)).toBe(true);
		await name({});
		expect(isSpareSlot(slotFile)).toBe(false);
		await name({ spare: false });
		expect(isSpareSlot(slotFile)).toBe(false);
		await rm(slotFile);
		expect(isSpareSlot(slotFile)).toBe(false);
	});
});

describe("a warm spare", () => {
	it("warms before it says it is warm, and says what it holds once warm", async () => {
		let warmed = false;
		const marks = spareMarks(slotFile);
		const waiting = spareUntilTaken(
			waitOf({
				warm: async () => {
					expect(existsSync(marks.warm)).toBe(false);
					warmed = true;
				},
			}),
		);
		await until(marks.warm);
		expect(warmed).toBe(true);
		expect(said).toEqual([
			expect.stringMatching(
				/^A warm spare: warmed in \d+\.\d s, holding 100 MB$/,
			),
		]);
		expect(await takeSpare(marks)).toBe(true);
		await name({});
		await expect(waiting).resolves.toEqual({ taken: true });
	});

	it("starts as what its slot names once taken", async () => {
		const marks = spareMarks(slotFile);
		const waiting = spareUntilTaken(waitOf());
		await until(marks.warm);
		expect(await takeSpare(marks)).toBe(true);
		expect(existsSync(marks.warm)).toBe(false);
		expect(existsSync(marks.taken)).toBe(true);
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
		expect(existsSync(marks.warm)).toBe(false);
		expect(await takeSpare(marks)).toBe(false);
	});

	it("stays for a take that landed before its leave", async () => {
		const marks = spareMarks(slotFile);
		let moved = false;
		const waiting = spareUntilTaken(
			waitOf({
				moved: async () => (moved ? "its install moved" : undefined),
			}),
		);
		await until(marks.warm);
		expect(await takeSpare(marks)).toBe(true);
		moved = true;
		// Past several of its looks, so a leave would have landed by now.
		await new Promise((resolve) => setTimeout(resolve, 80));
		await name({});
		await expect(waiting).resolves.toEqual({ taken: true });
	});

	it("leaves a take that names nothing within its time", async () => {
		const marks = spareMarks(slotFile);
		const waiting = spareUntilTaken(waitOf({ takeWithinMs: 30 }));
		await until(marks.warm);
		expect(await takeSpare(marks)).toBe(true);
		await expect(waiting).resolves.toEqual({
			left: "it was taken, but its slot named nothing within 0.03 s",
		});
	});

	it("leaves once it holds more than a spare may, before or after it is warm", async () => {
		const tooBig = spareUntilTaken(waitOf({ size: () => 250 * MB }));
		await expect(tooBig).resolves.toEqual({
			left: "it holds 250 MB, past the 200 MB a spare may",
		});
		expect(existsSync(spareMarks(slotFile).warm)).toBe(false);
		let held = 100 * MB;
		const growing = spareUntilTaken(waitOf({ size: () => held }));
		await until(spareMarks(slotFile).warm);
		held = 201 * MB;
		await expect(growing).resolves.toEqual({
			left: "it holds 201 MB, past the 200 MB a spare may",
		});
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
		expect(existsSync(spareMarks(slotFile).warm)).toBe(false);
		expect(said).toEqual([]);
	});
});

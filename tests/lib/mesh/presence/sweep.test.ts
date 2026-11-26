/**
 * The sweep of presence files no reader can read: it judges only text
 * it read, so a read that failed keeps the file, and it keeps a file a
 * publish landed on while it was read. A publish between the re-stat
 * and the unlink is beyond any test here.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPresences } from "../../../../lib/mesh/presence.ts";
import { presence } from "./support/presences.ts";

// What happens once a test's file is read: the read failing, or a
// publish landing on it just after.
const reading = vi.hoisted(() => ({
	path: undefined as string | undefined,
	after: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
			const text = fs.readFileSync(...args);
			if (String(args[0]) === reading.path) reading.after?.();
			return text;
		}) as typeof fs.readFileSync,
	};
});

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-sweep-"));
	reading.path = undefined;
	reading.after = undefined;
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A torn presence file in a fresh folder, older than the sweep's line. */
function tornAndOld(): { dir: string; torn: string } {
	const dir = join(root, "presence");
	mkdirSync(dir, { recursive: true });
	const torn = join(dir, "s-torn.json");
	writeFileSync(torn, "{");
	const old = new Date(Date.now() - 60_000);
	utimesSync(torn, old, old);
	return { dir, torn };
}

describe("the sweep of unreadable presences", () => {
	// An idle peer's file can go untouched past the line while it is still
	// on the mesh; a read failing for want of a file handle says nothing
	// of what the file holds.
	it("keeps a file whose read failed", () => {
		const { dir, torn } = tornAndOld();
		const presences = createPresences(dir);
		reading.path = torn;
		reading.after = () => {
			throw Object.assign(new Error("EMFILE: too many open files"), {
				code: "EMFILE",
			});
		};

		presences.expire(Date.now() - 30_000);

		expect(existsSync(torn), "a failed read judges nothing").toBe(true);
	});

	// The writer's publish renames a whole new file over the path, after
	// the sweep read the torn one and before it removed it.
	it("keeps a file a publish landed on while it was read", () => {
		const { dir, torn } = tornAndOld();
		const presences = createPresences(dir);
		const published = JSON.stringify(presence({ session: "s-torn" }));
		reading.path = torn;
		reading.after = () => {
			reading.after = undefined;
			const staged = join(dir, "s-torn.json.staged");
			writeFileSync(staged, published);
			renameSync(staged, torn);
		};

		presences.expire(Date.now() - 30_000);

		expect(existsSync(torn), "the live writer's publish").toBe(true);
		expect(readFileSync(torn, "utf8")).toBe(published);
	});

	it("still removes a torn file nothing published over", () => {
		const { dir, torn } = tornAndOld();

		createPresences(dir).expire(Date.now() - 30_000);

		expect(existsSync(torn), `the torn file is removed: ${torn}`).toBe(false);
	});
});

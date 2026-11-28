/** A heap snapshot summed by type: its figures, what it never names, and the process it is summed in. */
import { execFile } from "node:child_process";
import {
	mkdtemp,
	readFile,
	rm,
	stat,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	LARGE_STRING_BYTES,
	parseHeapSummary,
	sumApart,
	summarizeSnapshot,
	TOP_ROWS,
} from "../../../host/service/heap-summary.ts";
import { MARKER_CHARS, markerText, THINGS } from "./support/marked-heap.ts";

const MARKED_HEAP = join(import.meta.dirname, "support", "marked-heap.ts");
const OWNER_ONLY_FILE = 0o600;
const PERMISSIONS = 0o777;
/** A slice of the marker long enough that finding one means its text leaked. */
const SLICE_CHARS = 20;
/** Two snapshots of a small process, and their sums, on a busy machine. */
const PROCESS_MS = 60_000;

const run = promisify(execFile);

let dir: string;
let before: string;
let after: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "heap-summary-"));
	before = join(dir, "before.heapsnapshot");
	after = join(dir, "after.heapsnapshot");
	await run(process.execPath, [
		"--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
		MARKED_HEAP,
		before,
		after,
	]);
}, PROCESS_MS);
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** Whether `text` holds the marker, or any slice of it SLICE_CHARS long. */
function holdsMarker(text: string, marker: string): boolean {
	for (let at = 0; at + SLICE_CHARS <= marker.length; at++)
		if (text.includes(marker.slice(at, at + SLICE_CHARS))) return true;
	return false;
}

describe("a heap snapshot's summary", () => {
	it("names a class by how many instances it has", () => {
		const summary = summarizeSnapshot(after);

		expect(summary.byTypeAndName).toContainEqual({
			type: "object",
			name: "MarkedThing",
			count: THINGS,
			selfSize: expect.any(Number),
		});
		expect(summary.byTypeAndName.length).toBeLessThanOrEqual(TOP_ROWS);
		expect(summary.nodes).toBe(
			summary.byType.reduce((sum, row) => sum + row.count, 0),
		);
	});

	it("counts the marker among the strings of 64 KiB or more", () => {
		const without = summarizeSnapshot(before).largeStrings;
		const held = summarizeSnapshot(after).largeStrings;

		expect(held.atLeast).toBe(LARGE_STRING_BYTES);
		expect(held.count - without.count, "the marker alone").toBe(1);
		expect(held.selfSize - without.selfSize).toBeGreaterThanOrEqual(
			MARKER_CHARS,
		);
	});

	it("holds none of the marker's text, nor any slice of it", async () => {
		const marker = markerText();
		const into = join(dir, "after.summary.json");

		await sumApart(after, into);

		const text = await readFile(into, "utf8");
		expect(
			(await readFile(after, "utf8")).includes(marker.slice(0, SLICE_CHARS)),
			"the raw snapshot holds its opening, as far as V8 writes a string",
		).toBe(true);
		expect(text.includes(marker)).toBe(false);
		expect(holdsMarker(text, marker)).toBe(false);
		expect(holdsMarker(JSON.stringify(summarizeSnapshot(after)), marker)).toBe(
			false,
		);
	});

	it(
		"is summed in a process of its own into an owner-only file, as it sums here",
		async () => {
			const into = join(dir, "apart.summary.json");

			await sumApart(after, into);

			expect((await stat(into)).mode & PERMISSIONS).toBe(OWNER_ONLY_FILE);
			expect(
				parseHeapSummary(JSON.parse(await readFile(into, "utf8"))),
			).toEqual(summarizeSnapshot(after));
		},
		PROCESS_MS,
	);

	it("never writes over a summary already there", async () => {
		const into = join(dir, "kept.summary.json");
		await writeFile(into, "kept");

		await expect(sumApart(after, into)).rejects.toThrow("EEXIST");
		expect(await readFile(into, "utf8")).toBe("kept");
	});

	it("is refused for a snapshot cut short, saying why", async () => {
		const cut = join(dir, "cut.heapsnapshot");
		await writeFile(cut, await readFile(after));
		await truncate(cut, Math.floor((await stat(after)).size / 2));

		expect(() => summarizeSnapshot(cut)).toThrow(
			"Not a heap snapshot as V8 writes one",
		);
		await expect(sumApart(cut, join(dir, "cut.summary.json"))).rejects.toThrow(
			"Not a heap snapshot as V8 writes one",
		);
	});
});

describe("a heap snapshot's names", () => {
	/** A snapshot of one node of each kind given, named by the string at its index. */
	async function snapshotOf(
		nodes: readonly { type: number; size: number }[],
		strings: readonly string[],
	): Promise<string> {
		const file = join(
			dir,
			`made-${nodes.length}-${strings.length}.heapsnapshot`,
		);
		const made = {
			snapshot: {
				meta: {
					node_fields: ["type", "name", "id", "self_size", "edge_count"],
					node_types: [
						["hidden", "object", "regexp", "string", "closure"],
						"string",
						"number",
						"number",
						"number",
					],
				},
				node_count: nodes.length,
			},
			nodes: nodes.flatMap(({ type, size }, index) => [
				type,
				index,
				index,
				size,
				0,
			]),
			edges: [],
			trace_tree: [[0, [1, []]]],
			strings,
		};
		await writeFile(file, JSON.stringify(made, null, 1));
		return file;
	}

	it("names data by its kind alone, and anything else by its name", async () => {
		const file = await snapshotOf(
			[
				{ type: 1, size: 40 },
				{ type: 2, size: 30 },
				{ type: 3, size: 20 },
				{ type: 4, size: 10 },
			],
			["Thing", "secret-regexp-source", "secret-string-text", "named"],
		);

		const summary = summarizeSnapshot(file);

		expect(summary.byTypeAndName).toEqual([
			{ type: "object", name: "Thing", count: 1, selfSize: 40 },
			{ type: "regexp", count: 1, selfSize: 30 },
			{ type: "string", count: 1, selfSize: 20 },
			{ type: "closure", name: "named", count: 1, selfSize: 10 },
		]);
		expect(JSON.stringify(summary)).not.toMatch(/secret/);
	});

	it("cuts a long name, its escapes and characters kept whole", async () => {
		const long = `"é\\\n${"\u{1F600}x".repeat(3000)}`;
		const file = await snapshotOf([{ type: 0, size: 8 }], [long]);

		const [row] = summarizeSnapshot(file).byTypeAndName;

		expect(row?.name).toBe(`${[...long].slice(0, 100).join("")}...`);
	});
});

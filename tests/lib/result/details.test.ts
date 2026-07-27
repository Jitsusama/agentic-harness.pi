import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundedByDetails } from "../../../lib/result/details.js";
import { citeListing } from "../../../lib/result/listing.js";
import { queryStored } from "../../../lib/result/query.js";
import {
	createResultStore,
	type ResultStore,
} from "../../../lib/result/store.js";

const NARROWING = "Ask for fewer.";

/** A rendered view certain to overrun any listing budget. */
function longView(label: string): string {
	return Array.from(
		{ length: 400 },
		(_, i) => `${label} row ${i}: a line with enough text on it to count`,
	).join("\n");
}

/** The handle a citation names, or nothing when it cited none. */
function handleIn(text: string): string | undefined {
	return /handle (result-[0-9a-f]{16})/.exec(text)?.[1];
}

describe("bounding an answer by the details behind it", () => {
	let dir: string;
	let store: ResultStore;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "details-"));
		store = createResultStore({ dir });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("leaves an answer that already fits completely alone", () => {
		const text = boundedByDetails(store, {
			text: "three messages",
			details: { messages: [1, 2, 3] },
			narrowing: NARROWING,
		});

		expect(text).toBe("three messages");
	});

	it("names what it stored, when the details say what they hold", () => {
		const messages = Array.from({ length: 400 }, (_, i) => ({ id: i }));

		const text = boundedByDetails(store, {
			text: longView("message"),
			details: { messages },
			narrowing: NARROWING,
		});

		expect(text).toContain("400 messages");
		expect(handleIn(text)).toBeDefined();
	});

	it("bounds a listing whose records sit one level down", () => {
		// The quest verbs' shape. Nothing at the top level is an array,
		// so a heuristic looking only there finds nothing, and the seam
		// that was wired to bound this returned the whole answer
		// untouched at any length.
		const rows = Array.from({ length: 400 }, (_, i) => ({ id: `Q-${i}` }));

		const text = boundedByDetails(store, {
			text: longView("quest"),
			details: { listing: { rows, total: rows.length } },
			narrowing: NARROWING,
		});

		expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(
			Buffer.byteLength(longView("quest"), "utf-8"),
		);

		const handle = handleIn(text);
		expect(handle).toBeDefined();
		const followed = queryStored(
			store,
			handle as string,
			"$.listing.rows[*].id",
		);
		expect(followed.matches).toBe(400);
	});

	it("keeps the thing it cut, not merely something nearby", () => {
		// A document read: the view renders the body, while the only
		// array in the details is the comment list. Citing the comments
		// answers a question nobody asked and loses the body, which is
		// the part that was actually cut.
		const body = longView("paragraph");

		const text = boundedByDetails(store, {
			text: body,
			details: {
				file: { name: "Design Notes" },
				content: body,
				comments: [{ id: "c1", text: "one comment" }],
			},
			narrowing: NARROWING,
		});

		const handle = handleIn(text);
		expect(handle).toBeDefined();
		const followed = queryStored(store, handle as string, "$.content");
		expect(followed.json).toContain("paragraph row 399");
	});

	it("still bounds an answer that carries no details at all", () => {
		const view = longView("bare");

		const text = boundedByDetails(store, {
			text: view,
			details: undefined,
			narrowing: NARROWING,
		});

		// Nothing structured to store is not a licence to inline
		// everything: the rendering itself is what the caller loses, so
		// the rendering is what gets kept.
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(
			Buffer.byteLength(view, "utf-8"),
		);
		expect(handleIn(text)).toBeDefined();
	});
});

describe("when the store cannot be written to", () => {
	let base: string;

	beforeEach(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), "unwritable-"));
	});

	afterEach(() => {
		fs.rmSync(base, { recursive: true, force: true });
	});

	it("answers anyway, and says the rest is unreachable", () => {
		// A directory that cannot be created, because a file is sitting
		// where it would go. This is the shape of the real fault: a
		// temp directory that is unwritable, full, or owned by someone
		// else.
		const blocked = path.join(base, "in-the-way");
		fs.writeFileSync(blocked, "not a directory");
		const store = createResultStore({ dir: path.join(blocked, "results") });
		const view = longView("blocked");

		const text = boundedByDetails(store, {
			text: view,
			details: { rows: Array.from({ length: 400 }, (_, i) => ({ i })) },
			narrowing: NARROWING,
		});

		// The answer is what the caller asked for; the handle was a
		// convenience. Losing the convenience must not cost them the
		// answer, and they have to be told the remainder is gone rather
		// than left to assume the view was everything.
		expect(text).toContain("blocked row 0");
		expect(text).toContain("could not be stored");
	});
});

describe("a listing with a long view and no records", () => {
	let dir: string;
	let store: ResultStore;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "empty-"));
		store = createResultStore({ dir });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("keeps the rendering rather than citing an empty collection", () => {
		const view = longView("rendered");

		const text = citeListing(store, {
			view,
			records: [],
			unit: "findings",
			narrowing: "Ask for fewer.",
		});

		// A view can be rendered from more than the collection handed
		// over: the findings view draws stack findings too. Citing the
		// empty list said "All 0 findings are stored", which invites a
		// query that can only come back empty and reads as though the
		// answer were empty rather than the payload being wrong.
		expect(text).not.toContain("All 0 findings");
		const handle = handleIn(text);
		expect(handle).toBeDefined();
		const followed = queryStored(store, handle as string, "$");
		expect(followed.json).toContain("rendered row 399");
	});
});

describe("a listing whose tail the caller needs", () => {
	let dir: string;
	let store: ResultStore;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "trailer-"));
		store = createResultStore({ dir });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("keeps the trailer when the view is cut out from under it", () => {
		const text = citeListing(store, {
			view: longView("announcement"),
			records: Array.from({ length: 400 }, (_, i) => ({ i })),
			unit: "announcements",
			narrowing: "Read from the cursor.",
			trailer: "cursor: 400",
		});

		// The cursor is how the next call continues. Written into the
		// view it sat on the last line, and a leading-lines budget takes
		// the last line first, so the one page noisy enough to need
		// bounding is the page you cannot keep reading.
		expect(text).toContain("cursor: 400");
	});

	it("adds nothing but the trailer when the view already fits", () => {
		const text = citeListing(store, {
			view: "polite: one thing was said",
			records: [{ i: 0 }],
			unit: "announcements",
			narrowing: "Read from the cursor.",
			trailer: "cursor: 1",
		});

		expect(text).toBe("polite: one thing was said\n\ncursor: 1");
	});
});

describe("a view that elides without being cut", () => {
	let dir: string;
	let store: ResultStore;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "elided-"));
		store = createResultStore({ dir });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("cites the records a short view left out", () => {
		// An audit report: four rules, five example elements each, and a
		// count of the thousands it did not print. It fits any budget
		// comfortably, so nothing is cut, and keying the citation on the
		// cut alone left the answer with the most missing as the one
		// answer offering no way to reach it.
		const records = Array.from({ length: 8_001 }, (_, i) => ({
			selector: `#el-${i}`,
		}));

		const text = citeListing(store, {
			view: "region: 8,001 elements\n  #el-0\n  ... and 7,996 more",
			records,
			unit: "findings",
			narrowing: "Query the findings by rule.",
			elided: true,
		});

		const handle = handleIn(text);
		expect(handle).toBeDefined();
		const followed = queryStored(store, handle as string, "$[*].selector");
		expect(followed.matches).toBe(8_001);
	});
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundedByDetails } from "../../../lib/result/details.js";
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

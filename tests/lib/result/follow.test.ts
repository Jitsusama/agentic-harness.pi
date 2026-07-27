import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cite } from "../../../lib/result/cite.js";
import {
	offerQueryTool,
	withdrawQueryTool,
} from "../../../lib/result/follow.js";
import {
	createResultStore,
	type ResultStore,
} from "../../../lib/result/store.js";

describe("what a citation tells the reader to do next", () => {
	let dir: string;
	let store: ResultStore;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "follow-"));
		store = createResultStore({ dir });
	});

	afterEach(() => {
		withdrawQueryTool();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const cut = () =>
		cite(store, {
			payload: Array.from({ length: 50 }, (_, i) => ({ i })),
			view: "one line of fifty",
			shown: 1,
			total: 50,
			unit: "lines",
		}).text;

	it("names the tool that can read the handle when one is loaded", () => {
		offerQueryTool("result_query");

		expect(cut()).toContain("Query it with result_query");
	});

	it("does not promise a call that cannot be made", () => {
		// The tools that mint handles and the tool that reads them are
		// separate extensions, each loadable alone. Naming the reader
		// when it is absent tells the caller the rest of the data is one
		// call away, and the call does not exist.
		withdrawQueryTool();
		const text = cut();

		expect(text).not.toContain("Query it with");
		expect(text).toContain("cannot be followed");
		expect(text).toContain("result-store-workflow");
	});

	it("still says what shape the payload has, either way", () => {
		withdrawQueryTool();

		expect(cut()).toContain("Shape:");
	});
});

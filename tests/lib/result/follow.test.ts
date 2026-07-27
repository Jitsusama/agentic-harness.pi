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

type FollowModule = typeof import("../../../lib/result/follow.js");

/**
 * One more instance of the module, the way pi's loader produces
 * them. The specifier is built at runtime so TypeScript resolves
 * the module for its types without trying to resolve the query
 * string that makes each import a separate instance.
 */
async function separateCopy(tag: string): Promise<FollowModule> {
	const spec = `../../../lib/result/follow.js?copy=${tag}`;
	return (await import(spec)) as FollowModule;
}

describe("two extensions that each loaded their own copy", () => {
	afterEach(() => {
		withdrawQueryTool();
	});

	it("share one answer about what can follow a handle", async () => {
		// Pi loads each extension separately, so the store extension
		// and the browser extension do not share a module instance. A
		// plain module variable meant the copy that was written to was
		// not the copy that was read from, and every citation said no
		// tool could follow the handle in a session where result_query
		// read them all. The query strings here are how one process
		// gets two instances of one module, which is what pi's loader
		// does by other means.
		const store = await separateCopy("store");
		const browser = await separateCopy("browser");
		expect(store).not.toBe(browser);

		store.offerQueryTool("result_query");

		expect(browser.queryTool()).toBe("result_query");
	});
});

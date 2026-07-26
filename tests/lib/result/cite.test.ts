import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cite } from "../../../lib/result/cite.js";
import {
	createResultStore,
	type ResultStore,
} from "../../../lib/result/store.js";

describe("cite", () => {
	let dir: string;
	let store: ResultStore;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "cite-"));
		store = createResultStore({ dir });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("says nothing when the view already shows everything", () => {
		const cited = cite(store, {
			payload: [{ id: 1 }],
			view: "one thing",
			shown: 1,
			total: 1,
			unit: "things",
		});

		expect(cited.text).toBe("one thing");
		expect(cited.handle).toBeUndefined();
	});

	it("stores the payload and cites it when the view is partial", () => {
		const payload = Array.from({ length: 40 }, (_, i) => ({
			id: i,
			role: "button",
		}));

		const cited = cite(store, {
			payload,
			view: "first 3 of them",
			shown: 3,
			total: payload.length,
			unit: "nodes",
		});

		expect(cited.handle).toBeDefined();
		expect(cited.text).toContain("first 3 of them");
		// The numbers in the sentence are the ones it was given.
		expect(cited.text).toContain(`All ${payload.length} nodes are stored`);
		expect(cited.text).toContain("this answer shows 3");
		expect(cited.text).toContain(`handle ${cited.handle}`);
		// And the handle resolves to the whole payload, not the view.
		const stored = store.read(cited.handle as string);
		expect(JSON.parse(stored)).toEqual(payload);
	});

	it("describes the payload's shape so a caller can query it", () => {
		const cited = cite(store, {
			payload: { requests: [{ url: "https://example.test", status: 200 }] },
			view: "one request",
			shown: 1,
			total: 2,
			unit: "requests",
		});

		// The digest names the fields, which is what a query needs.
		expect(cited.text).toContain("Shape:");
		expect(cited.text).toContain("requests");
		expect(cited.text).toContain("status");
	});

	it("names result_query, since a handle with no verb is a dead end", () => {
		const cited = cite(store, {
			payload: [1, 2, 3],
			view: "one",
			shown: 1,
			total: 3,
			unit: "numbers",
		});

		expect(cited.text).toContain("result_query");
	});

	it("keeps the answer and admits the remainder is gone when storing fails", () => {
		const broken: ResultStore = {
			put() {
				throw new Error("disk went away");
			},
			read() {
				throw new Error("not reached");
			},
			has: () => false,
			clear: () => {},
		};

		const cited = cite(broken, {
			payload: [1, 2, 3],
			view: "the view survives",
			shown: 1,
			total: 3,
			unit: "numbers",
		});

		expect(cited.text).toContain("the view survives");
		expect(cited.text).toContain("disk went away");
		// The caller must not be left thinking the view was everything.
		expect(cited.text).toContain("not retrievable");
		expect(cited.handle).toBeUndefined();
	});
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createResultStore,
	HandleExpiredError,
} from "../../../lib/result/store.js";

describe("createResultStore", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("resolves a handle another instance minted", () => {
		// This is the whole reason the store is its directory. The
		// browser tools put a payload from one instance and the query
		// tool reads it from another, in the same process but a
		// different extension.
		const writer = createResultStore({ dir });
		const reader = createResultStore({ dir });

		const stored = writer.put('{"outline":"deep"}');

		expect(reader.has(stored.handle)).toBe(true);
		expect(reader.read(stored.handle)).toBe('{"outline":"deep"}');
	});

	it("counts what is on disk, not what it remembers writing", () => {
		// Two instances over one directory, each with the same quota:
		// the quota is the directory's, so the second instance evicts
		// the first instance's payload rather than adding to it.
		const first = createResultStore({ dir, maxBytes: 40 });
		const second = createResultStore({ dir, maxBytes: 40 });

		const old = first.put("x".repeat(30));
		second.put("y".repeat(30));

		expect(second.has(old.handle)).toBe(false);
	});

	it("refuses a handle that is not one, rather than reading a path", () => {
		// A handle comes from a language model, so it can be anything,
		// including a route out of the store.
		const store = createResultStore({ dir });
		const outside = path.join(dir, "..", "escape.json");
		fs.writeFileSync(outside, "not yours");

		try {
			for (const attempt of [
				"../escape",
				"..%2Fescape",
				"/etc/passwd",
				"result-nothex000000000",
			]) {
				expect(store.has(attempt)).toBe(false);
				expect(() => store.read(attempt)).toThrow(HandleExpiredError);
			}
		} finally {
			fs.rmSync(outside, { force: true });
		}
	});

	it("ignores files in the directory that it did not mint", () => {
		const store = createResultStore({ dir, maxBytes: 10 });
		const foreign = path.join(dir, "someone-elses-notes.txt");
		fs.writeFileSync(foreign, "z".repeat(500));

		// The foreign file neither counts towards the quota nor gets
		// deleted to make room: this directory is not exclusively ours.
		const stored = store.put("mine");

		expect(fs.existsSync(foreign)).toBe(true);
		expect(store.read(stored.handle)).toBe("mine");
	});
});

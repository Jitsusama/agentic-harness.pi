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

	it("gives one handle to one payload, however often it is stored", () => {
		// Found by driving: a navigation and the page read after it both
		// cited the same outline under different handles, so the session
		// held two copies of a megabyte and neither citation was wrong.
		const store = createResultStore({ dir });
		const outline = JSON.stringify({ nodes: [{ role: "heading" }] });

		const first = store.put(outline);
		const again = store.put(outline);

		expect(again.handle).toBe(first.handle);
		expect(fs.readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(
			1,
		);
		expect(store.read(first.handle)).toBe(outline);
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

	it("cannot be talked into reading a file outside its directory", () => {
		// A handle comes from a language model, so it can be anything,
		// including a route out of the store. The shape check is the only
		// thing standing between that string and the filesystem: deleting
		// it from pathFor makes has("../escape") return true and read()
		// hand back the planted file, which is how this was confirmed to
		// be protection rather than decoration.
		const store = createResultStore({ dir });
		const outside = path.join(dir, "..", "escape.json");
		fs.writeFileSync(outside, "not yours");

		try {
			for (const attempt of ["../escape", "..%2Fescape", "/etc/passwd"]) {
				expect(store.has(attempt)).toBe(false);
				expect(() => store.read(attempt)).toThrow(HandleExpiredError);
			}
			expect(fs.readFileSync(outside, "utf-8")).toBe("not yours");
		} finally {
			fs.rmSync(outside, { force: true });
		}
	});

	it("treats a well-formed handle it never minted as expired", () => {
		// Distinct from the traversal case above, which the shape check
		// refuses outright. This one is shaped exactly like a handle and
		// simply is not here, which is what a caller sees after eviction.
		const store = createResultStore({ dir });

		expect(store.has("result-0123456789abcdef")).toBe(false);
		expect(() => store.read("result-0123456789abcdef")).toThrow(
			HandleExpiredError,
		);
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

describe("a payload that is present but unreadable", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "unreadable-"));
	});

	afterEach(() => {
		fs.chmodSync(dir, 0o700);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("says what went wrong instead of claiming it expired", () => {
		const store = createResultStore({ dir });
		const { handle } = store.put("still here");
		fs.chmodSync(path.join(dir, `${handle}.json`), 0o000);

		// Calling this an expiry sends the caller back to re-run the
		// work that produced the payload, which will fail identically,
		// and drops the only detail that explains why.
		let thrown: unknown;
		try {
			store.read(handle);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(HandleExpiredError);
		expect((thrown as Error).message).toContain("could not be read");
	});
});

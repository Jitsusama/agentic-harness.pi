import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createResultStore,
	HandleExpiredError,
} from "../../../lib/mcp/store.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-store-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("createResultStore", () => {
	it("spills a payload and resolves its handle back to the original text", () => {
		const store = createResultStore({ dir });
		const stored = store.put("hello world");
		expect(store.read(stored.handle)).toBe("hello world");
		expect(store.has(stored.handle)).toBe(true);
		expect(fs.readFileSync(stored.path, "utf-8")).toBe("hello world");
	});

	it("throws HandleExpiredError for an unknown handle", () => {
		const store = createResultStore({ dir });
		expect(() => store.read("nope")).toThrow(HandleExpiredError);
		expect(store.has("nope")).toBe(false);
	});

	it("evicts the oldest entry when the disk quota is exceeded", () => {
		const store = createResultStore({ dir, maxBytes: 10 });
		const first = store.put("aaaaaa");
		const second = store.put("bbbbbb");
		expect(() => store.read(first.handle)).toThrow(HandleExpiredError);
		expect(store.read(second.handle)).toBe("bbbbbb");
	});

	it("keeps a payload that alone exceeds the quota readable", () => {
		const store = createResultStore({ dir, maxBytes: 4 });
		const stored = store.put("a much larger payload than the quota");
		expect(store.read(stored.handle)).toBe(
			"a much larger payload than the quota",
		);
		expect(store.has(stored.handle)).toBe(true);
	});

	it("has returns false once the backing file vanishes", () => {
		const store = createResultStore({ dir });
		const stored = store.put("payload");
		fs.rmSync(stored.path);
		expect(store.has(stored.handle)).toBe(false);
	});

	it("expires a handle whose file somebody else removed", () => {
		// This is what tearing a session down looks like from inside a
		// store: the directory goes, and every handle stops resolving.
		// A store has no clear() of its own, because the directory is
		// shared and emptying it would take handles other extensions
		// had already given out.
		const store = createResultStore({ dir });
		const stored = store.put("payload");

		fs.rmSync(stored.path, { force: true });

		expect(() => store.read(stored.handle)).toThrow(HandleExpiredError);
		expect(store.has(stored.handle)).toBe(false);
	});

	it("throws HandleExpiredError when the backing file vanishes", () => {
		const store = createResultStore({ dir });
		const stored = store.put("payload");
		fs.rmSync(stored.path);
		expect(() => store.read(stored.handle)).toThrow(HandleExpiredError);
	});
});

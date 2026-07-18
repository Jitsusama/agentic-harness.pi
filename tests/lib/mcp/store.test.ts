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

	it("clear removes files and makes every handle expire", () => {
		const store = createResultStore({ dir });
		const stored = store.put("payload");
		store.clear();
		expect(() => store.read(stored.handle)).toThrow(HandleExpiredError);
		expect(fs.existsSync(stored.path)).toBe(false);
	});

	it("throws HandleExpiredError when the backing file vanishes", () => {
		const store = createResultStore({ dir });
		const stored = store.put("payload");
		fs.rmSync(stored.path);
		expect(() => store.read(stored.handle)).toThrow(HandleExpiredError);
	});
});

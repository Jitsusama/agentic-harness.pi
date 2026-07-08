import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRuleStore } from "../../../lib/governance/store.js";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gov-store-"));
	path = join(dir, "nested", "rules.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("openRuleStore", () => {
	it("starts empty when the file does not exist", () => {
		expect(openRuleStore(path).list()).toEqual([]);
	});

	it("adds a rule with an id and timestamp and persists it", () => {
		const store = openRuleStore(path);
		const filed = store.add({ text: "  keep breadth unless told to narrow  " });
		expect(filed.id).toMatch(/^[0-9a-f]{8}$/);
		expect(filed.text).toBe("keep breadth unless told to narrow");
		expect(filed.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		// A fresh store over the same file sees the persisted rule.
		expect(openRuleStore(path).list()).toHaveLength(1);
	});

	it("keeps the source when given and omits it otherwise", () => {
		const store = openRuleStore(path);
		const withSource = store.add({ text: "a", source: "capture:s1" });
		const without = store.add({ text: "b" });
		expect(withSource.source).toBe("capture:s1");
		expect(without.source).toBeUndefined();
	});

	it("removes a rule by id and reports whether it removed one", () => {
		const store = openRuleStore(path);
		const filed = store.add({ text: "temporary" });
		expect(store.remove("nope")).toBe(false);
		expect(store.remove(filed.id)).toBe(true);
		expect(store.list()).toEqual([]);
		expect(openRuleStore(path).list()).toEqual([]);
	});

	it("replaces the whole set", () => {
		const store = openRuleStore(path);
		store.add({ text: "old" });
		store.replaceAll([
			{ id: "aa", text: "new", createdAt: "2026-01-01T00:00:00.000Z" },
		]);
		expect(store.list().map((r) => r.text)).toEqual(["new"]);
	});

	it("tolerates a corrupt file by starting empty", () => {
		const corrupt = join(dir, "corrupt.json");
		writeFileSync(corrupt, "{ not json");
		expect(openRuleStore(corrupt).list()).toEqual([]);
	});

	it("preserves a corrupt file aside instead of overwriting it", () => {
		const p = join(dir, "rules.json");
		writeFileSync(p, '[{"id":"a","text":"keep me"} oops');
		const store = openRuleStore(p);
		expect(store.list()).toEqual([]);
		// The unparseable content was moved aside, not lost.
		const backups = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
		expect(backups).toHaveLength(1);
		expect(readFileSync(join(dir, backups[0]), "utf8")).toContain("keep me");
	});

	it("drops malformed entries rather than rendering blanks", () => {
		const p = join(dir, "rules.json");
		writeFileSync(
			p,
			JSON.stringify([
				{ id: "a", text: "good", createdAt: "2026-01-01T00:00:00.000Z" },
				{ id: "b" },
				{ text: "no id" },
			]),
		);
		expect(
			openRuleStore(p)
				.list()
				.map((r) => r.text),
		).toEqual(["good"]);
	});

	it("reads through so a second store sees the first's writes", () => {
		const a = openRuleStore(path);
		const b = openRuleStore(path);
		a.add({ text: "from a" });
		expect(b.list().map((r) => r.text)).toEqual(["from a"]);
	});

	it("writes human-readable JSON", () => {
		openRuleStore(path).add({ text: "readable" });
		const raw = readFileSync(path, "utf8");
		expect(raw).toContain("\n  ");
		expect(raw.endsWith("\n")).toBe(true);
	});
});

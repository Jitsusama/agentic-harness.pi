import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	dropLastStructuralOp,
	lastStructuralOp,
	recordStructuralOp,
} from "../../../../lib/internal/quest/structural-journal";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "journal-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("structural journal", () => {
	it("returns undefined when no op has been recorded", () => {
		expect(lastStructuralOp(root)).toBeUndefined();
	});

	it("hands back the most recent recorded op", () => {
		recordStructuralOp(root, "reparent", [
			{ id: "QEST-1", field: "parent", old: null, new: "QEST-P" },
		]);
		recordStructuralOp(root, "reparent", [
			{ id: "QEST-2", field: "parent", old: "QEST-P", new: null },
		]);
		const last = lastStructuralOp(root);
		expect(last?.op).toBe("reparent");
		expect(last?.changes).toEqual([
			{ id: "QEST-2", field: "parent", old: "QEST-P", new: null },
		]);
	});

	it("drops the most recent op so the prior one resurfaces", () => {
		recordStructuralOp(root, "reparent", [
			{ id: "QEST-1", field: "parent", old: null, new: "QEST-P" },
		]);
		recordStructuralOp(root, "reparent", [
			{ id: "QEST-2", field: "parent", old: "QEST-P", new: null },
		]);
		dropLastStructuralOp(root);
		const last = lastStructuralOp(root);
		expect(last?.changes).toEqual([
			{ id: "QEST-1", field: "parent", old: null, new: "QEST-P" },
		]);
		dropLastStructuralOp(root);
		expect(lastStructuralOp(root)).toBeUndefined();
	});

	it("stamps each entry with a timestamp", () => {
		recordStructuralOp(root, "reparent", [
			{ id: "QEST-1", field: "parent", old: null, new: "QEST-P" },
		]);
		const last = lastStructuralOp(root);
		expect(typeof last?.ts).toBe("string");
		expect(Number.isNaN(Date.parse(last?.ts ?? ""))).toBe(false);
	});
});

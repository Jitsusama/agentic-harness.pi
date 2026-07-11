import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "../../../../lib/google/auth/store.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "google-store-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("google credentials store", () => {
	it("returns fresh defaults when the file is missing", () => {
		expect(readFile(join(dir, "absent.json"))).toEqual({
			accounts: [],
			tokens: {},
		});
	});

	it("returns fresh defaults when the file is corrupt", () => {
		const file = join(dir, "corrupt.json");
		writeFileSync(file, "{ not valid json");

		expect(readFile(file)).toEqual({ accounts: [], tokens: {} });
	});

	it("round-trips a written file", () => {
		const file = join(dir, "creds.json");
		const data = {
			accounts: [{ email: "a@b.com" }] as never,
			tokens: {},
		};

		writeFile(data, file);

		expect(readFile(file)).toEqual(data);
	});

	it("creates the parent directory on write", () => {
		const file = join(dir, "nested", "deep", "creds.json");

		writeFile({ accounts: [], tokens: {} }, file);

		expect(existsSync(file)).toBe(true);
	});
});

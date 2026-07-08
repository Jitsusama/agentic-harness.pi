import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadAdvisorEnabled,
	saveAdvisorEnabled,
} from "../../../extensions/advisor/settings.js";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "advisor-settings-"));
	path = join(dir, "nested", "settings.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("advisor settings", () => {
	it("defaults to disabled when no file exists", () => {
		expect(loadAdvisorEnabled(path)).toBe(false);
	});

	it("round-trips the enabled flag", () => {
		saveAdvisorEnabled(path, true);
		expect(loadAdvisorEnabled(path)).toBe(true);
		saveAdvisorEnabled(path, false);
		expect(loadAdvisorEnabled(path)).toBe(false);
	});

	it("stays disabled on a corrupt file", () => {
		const corrupt = join(dir, "corrupt.json");
		writeFileSync(corrupt, "{ not json");
		expect(loadAdvisorEnabled(corrupt)).toBe(false);
	});
});

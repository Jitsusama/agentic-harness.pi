import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryDbPath } from "../../../lib/memory/paths.ts";

const ORIGINAL = process.env.XDG_STATE_HOME;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "memory-paths-"));
	process.env.XDG_STATE_HOME = dir;
});

afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = ORIGINAL;
	rmSync(dir, { recursive: true, force: true });
});

describe("memoryDbPath", () => {
	it("honours XDG_STATE_HOME and creates the parent directory", async () => {
		const path = await memoryDbPath();

		expect(path).toBe(join(dir, "agentic-harness", "memory", "memory.db"));
		expect(existsSync(join(dir, "agentic-harness", "memory"))).toBe(true);
	});

	it("is stable across calls, not scoped to any one adapter", async () => {
		const first = await memoryDbPath();
		const second = await memoryDbPath();

		expect(first).toBe(second);
	});
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPackageConfig } from "../../../../lib/internal/config/loader";

describe("loadPackageConfig", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pkg-config-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("treats a missing file as an empty config", async () => {
		const path = join(dir, "config.json");
		const result = await loadPackageConfig(path);
		expect(result).toEqual({
			ok: true,
			path,
			config: { version: 1, sections: {} },
		});
	});

	it("reads a well-formed envelope", async () => {
		const path = join(dir, "config.json");
		const sections = { "quest-workflow": { questsRoot: "/tmp/q" } };
		await writeFile(path, JSON.stringify({ version: 1, sections }), "utf8");
		const result = await loadPackageConfig(path);
		expect(result).toEqual({
			ok: true,
			path,
			config: { version: 1, sections },
		});
	});

	it("fails on malformed JSON", async () => {
		const path = join(dir, "config.json");
		await writeFile(path, "{ not json", "utf8");
		const result = await loadPackageConfig(path);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.path).toBe(path);
		expect(result.error).toMatch(/pars/i);
	});

	it("fails when the root is not an object", async () => {
		const path = join(dir, "config.json");
		await writeFile(path, JSON.stringify([1, 2, 3]), "utf8");
		const result = await loadPackageConfig(path);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.error).toMatch(/object/i);
	});

	it("fails when sections is not an object", async () => {
		const path = join(dir, "config.json");
		await writeFile(path, JSON.stringify({ version: 1, sections: 7 }), "utf8");
		const result = await loadPackageConfig(path);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.error).toMatch(/sections/i);
	});
});

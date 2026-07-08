import { describe, expect, it } from "vitest";
import { resolveCheckCommand } from "../../../lib/verification/resolve.js";

describe("resolveCheckCommand", () => {
	it("prefers a quest verify field over everything", () => {
		const resolved = resolveCheckCommand({
			questVerify: "dev check",
			packageScripts: { verify: "pnpm run verify", lint: "biome check ." },
		});
		expect(resolved).toEqual({ command: "dev check", source: "quest" });
	});

	it("uses a package verify script when there is no quest field", () => {
		const resolved = resolveCheckCommand({
			packageScripts: { verify: "biome check . && vitest run", lint: "x" },
		});
		expect(resolved).toEqual({ command: "pnpm run verify", source: "script" });
	});

	it("detects lint, typecheck and test scripts in order", () => {
		const resolved = resolveCheckCommand({
			packageScripts: { test: "vitest run", lint: "biome check ." },
		});
		expect(resolved).toEqual({
			command: "pnpm run lint && pnpm run test",
			source: "detected",
		});
	});

	it("honours the package manager for detected and script commands", () => {
		const resolved = resolveCheckCommand({
			packageManager: "npm",
			packageScripts: { typecheck: "tsc --noEmit" },
		});
		expect(resolved).toEqual({
			command: "npm run typecheck",
			source: "detected",
		});
	});

	it("returns null when nothing is available", () => {
		expect(resolveCheckCommand({ packageScripts: {} })).toBeNull();
		expect(resolveCheckCommand({})).toBeNull();
	});
});

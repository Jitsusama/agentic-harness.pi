/**
 * A council's reviewers read what a stranger may have written, so each
 * loads the extensions that run its commands in the fence, fence pi's
 * file tools and scrub credentials from their answers, which an
 * isolated reviewer would otherwise lack.
 */

import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fencePacks } from "../../../../extensions/review-integration/tools/ask-reviewer.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("the extensions a reviewer is fenced with", () => {
	it("are the shell, the file fence and the scrub, each where the package has it", () => {
		vi.stubEnv("PI_SANDBOX", "off");
		const packs = fencePacks();
		expect(packs.map((path) => path.split("/").at(-2))).toEqual([
			"shell-workflow",
			"sandbox-file-interceptor",
			"secret-scrub-interceptor",
		]);
		for (const path of packs)
			expect(existsSync(path), `${path} exists`).toBe(true);
	});

	it("aren't handed out by a fenced session running this package from outside the install", () => {
		// These tests run from a tree, never from pi's installed packages.
		vi.stubEnv("PI_SANDBOX", "strict");
		expect(() => fencePacks()).toThrow(
			/No reviewer started: This session runs the harness from .*, outside pi's installed packages/,
		);
	});

	it("each load as an extension does", async () => {
		vi.stubEnv("PI_SANDBOX", "off");
		for (const path of fencePacks()) {
			const loaded: unknown = await import(path);
			expect(loaded).toMatchObject({ default: expect.any(Function) });
		}
	});
});

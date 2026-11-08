/**
 * A council's reviewers read what a stranger may have written, so each
 * loads the extensions that fence pi's file tools and scrub credentials
 * from their answers, which an isolated reviewer would otherwise lack.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fencePacks } from "../../extensions/review-integration/tools/ask.ts";

describe("the extensions a reviewer is fenced with", () => {
	it("are the file fence and the scrub, each where the package has it", () => {
		const packs = fencePacks();
		expect(packs.map((path) => path.split("/").at(-2))).toEqual([
			"sandbox-file-interceptor",
			"secret-scrub-interceptor",
		]);
		for (const path of packs)
			expect(existsSync(path), `${path} exists`).toBe(true);
	});

	it("each load as an extension does", async () => {
		for (const path of fencePacks()) {
			const loaded: unknown = await import(path);
			expect(loaded).toMatchObject({ default: expect.any(Function) });
		}
	});
});

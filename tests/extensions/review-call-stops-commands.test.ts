/**
 * A review tool stopped stops the command it is waiting on.
 *
 * The review providers are built once and run their gh and git
 * through an exec they were handed then, so a tool's signal never
 * reached them, and a hung gh held the call to its clock whatever
 * Escape said. Every review tool now runs with its call's signal, and
 * a command it starts stops when that fires.
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandsWith } from "../../extensions/review-integration/commands.ts";
import { activate, HEADLESS, toolNamed } from "./support/review-extension.ts";

let bin: string;

beforeEach(async () => {
	// A gh that never answers, found first on the path.
	bin = await mkdtemp(join(tmpdir(), "hung-gh-"));
	const gh = join(bin, "gh");
	await writeFile(gh, "#!/bin/sh\nsleep 30\n");
	await chmod(gh, 0o755);
	vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(bin, { recursive: true, force: true });
});

describe("a review tool stopped while gh hangs", () => {
	it("stops gh and answers", async () => {
		const stub = activate();
		// The real runner, as a session has it, rather than the stub's.
		runCommandsWith(undefined);
		const see = toolNamed(stub, "review_see");
		const stop = new AbortController();
		const seeing = see.execute(
			"see",
			{ action: "change", change: "https://github.com/Shopify/world/pull/9" },
			stop.signal,
			undefined,
			HEADLESS,
		);
		setTimeout(() => stop.abort(), 200);

		const settled = await Promise.race([
			seeing.then(
				() => "answered",
				() => "answered",
			),
			new Promise((resolve) =>
				setTimeout(() => resolve("still waiting"), 3_000),
			),
		]);
		expect(settled).toBe("answered");
	}, 10_000);
});

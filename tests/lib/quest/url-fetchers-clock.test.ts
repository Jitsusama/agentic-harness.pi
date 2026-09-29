import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearUrlFetchers,
	fetchUrlHints,
	registerBuiltinUrlFetchers,
} from "../../../lib/quest/index";

/** Longer than a fetch given up on should take to end. */
const STILL_RUNNING_MS = 5000;

/** The fetch's outcome, or a note that it was still waiting. */
async function outcome(call: Promise<unknown>): Promise<unknown> {
	const running = new Promise<string>((resolve) =>
		setTimeout(() => resolve("still running"), STILL_RUNNING_MS),
	);
	return Promise.race([call, running]);
}

const PR = { type: "github-pr", value: "octo/repo#7" };

// The built-in fetchers ask gh, and gh can hang: on a login it wants, a
// network that went quiet, or a proxy that accepts and never answers.
// Quest creation waits on the fetch, and quest takes its calls one at a
// time, so a hung gh used to hold every later quest call behind it.
describe("a URL fetch through a gh that never answers", () => {
	let bin: string;
	let path: string | undefined;

	const fakeGh = (script: string): void => {
		const gh = join(bin, "gh");
		writeFileSync(gh, `#!/bin/sh\n${script}\n`);
		chmodSync(gh, 0o755);
	};

	beforeEach(() => {
		clearUrlFetchers();
		registerBuiltinUrlFetchers();
		bin = mkdtempSync(join(tmpdir(), "fake-gh-"));
		path = process.env.PATH;
		process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
	});

	afterEach(() => {
		process.env.PATH = path;
		clearUrlFetchers();
		rmSync(bin, { recursive: true, force: true });
	});

	it("is given up on at its clock, and the quest is seeded without it", async () => {
		fakeGh("sleep 30");
		expect(await outcome(fetchUrlHints(PR, { timeoutMs: 500 }))).toBe(
			undefined,
		);
	}, 15_000);

	it("is given up on the moment its caller stops", async () => {
		fakeGh("sleep 30");
		const controller = new AbortController();
		const call = fetchUrlHints(PR, { signal: controller.signal });
		setTimeout(() => controller.abort(), 300);
		expect(await outcome(call)).toBe(undefined);
	}, 15_000);

	it("still seeds from a gh that answers", async () => {
		fakeGh(
			`echo '{"title":"Fix the thing","body":"Because.","author":{"login":"octocat"}}'`,
		);
		expect(await outcome(fetchUrlHints(PR, { timeoutMs: 5000 }))).toEqual({
			title: "Fix the thing",
			excerpt: "Because.",
			originator: { type: "github", value: "octocat" },
		});
	}, 15_000);

	it("seeds nothing from a gh that fails", async () => {
		fakeGh("echo 'not logged in' >&2; exit 4");
		expect(await outcome(fetchUrlHints(PR, { timeoutMs: 5000 }))).toBe(
			undefined,
		);
	}, 15_000);
});

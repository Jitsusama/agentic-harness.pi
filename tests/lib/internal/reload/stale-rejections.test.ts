import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type DroppedRejection,
	handleRejection,
	isStaleContext,
} from "../../../../lib/internal/reload/stale-rejections.ts";

/** pi's own words, as `ExtensionRunner.assertActive` throws them. */
const STALE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

const MODULE = pathToFileURL(
	join(
		import.meta.dirname,
		"../../../../lib/internal/reload/stale-rejections.ts",
	),
).href;

describe("a rejection nothing watched", () => {
	it("is dropped and kept in the log when it is pi's stale-context error", () => {
		const dropped: DroppedRejection[] = [];

		handleRejection(new Error(STALE), (one) => dropped.push(one));

		expect(dropped).toHaveLength(1);
		expect(dropped[0]?.stack).toContain("stale-rejections.test.ts");
	});

	it("is thrown again, as it was, when it is anything else", () => {
		const other = new Error("the disk is full");
		const dropped: DroppedRejection[] = [];

		expect(() => handleRejection(other, (one) => dropped.push(one))).toThrow(
			other,
		);
		expect(() => handleRejection("a string", () => {})).toThrow("a string");
		expect(dropped).toEqual([]);
	});

	it("is pi's only when the message opens with pi's words", () => {
		expect(isStaleContext(new Error(STALE))).toBe(true);
		expect(isStaleContext(new Error(`wrapped: ${STALE}`))).toBe(false);
		expect(isStaleContext({ message: STALE })).toBe(false);
	});
});

describe("a process with the net", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "stale-rejections-"));
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	/** Run node with the net, rejecting `message` from a promise nothing watches. */
	function run(message: string, logs: readonly string[]) {
		const script = [
			`import { spareStaleRejections } from ${JSON.stringify(MODULE)};`,
			// Each load of the harness calls it; the latest load's log wins.
			...logs.map((log) => `spareStaleRejections(${JSON.stringify(log)});`),
			`void Promise.reject(new Error(${JSON.stringify(message)}));`,
			`setTimeout(() => console.log("alive", process.listenerCount("unhandledRejection")), 200);`,
		].join("\n");
		return spawnSync(
			process.execPath,
			["--input-type=module", "--no-warnings", "-e", script],
			{ encoding: "utf8", timeout: 15_000 },
		);
	}

	it("lives through a stale-context rejection and writes it to the latest log", () => {
		const first = join(scratch, "first.jsonl");
		const latest = join(scratch, "state", "latest.jsonl");

		const ran = run(STALE, [first, latest]);

		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stdout.trim(), "one handler for both loads").toBe("alive 1");
		const lines = readFileSync(latest, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "{}").stack).toContain(STALE.slice(0, 40));
	});

	it("still ends on any other rejection, as Node does without it", () => {
		const ran = run("the disk is full", [join(scratch, "log.jsonl")]);

		expect(ran.status).toBe(1);
		expect(ran.stderr).toContain("the disk is full");
		expect(ran.stdout).not.toContain("alive");
	});
});

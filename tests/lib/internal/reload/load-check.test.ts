/**
 * Reading what pi says when it loads a package, and driving a stand-in
 * pi through the same pipes to check the plumbing: stdin closed after
 * the one request, stderr read for failures, a hang cut off.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkLoad,
	describeLoad,
	loadCheckArgs,
	loadFailures,
	readLoad,
} from "../../../../lib/internal/reload/load-check.ts";

const PI_FAILURE = [
	"Error: Failed to load extension \"/t/extensions/advisor/index.ts\": Failed to load extension: Cannot find module '@jitsusama/agentic-harness.core/advisor'",
	"Require stack:",
	"- /t/extensions/advisor/index.ts",
	"Error: Failed to load extension \"/t/extensions/browser/index.ts\": Failed to load extension: Cannot find module 'pixelmatch'",
].join("\n");

const ANSWER = `${JSON.stringify({
	id: "load-check",
	type: "response",
	command: "get_commands",
	success: true,
	data: { commands: [{ name: "a" }, { name: "b" }] },
})}\n`;

describe("reading pi's answer", () => {
	it("names each extension that failed, with its cause", () => {
		expect(loadFailures(PI_FAILURE)).toEqual([
			{
				extension: "/t/extensions/advisor/index.ts",
				error: "Cannot find module '@jitsusama/agentic-harness.core/advisor'",
			},
			{
				extension: "/t/extensions/browser/index.ts",
				error: "Cannot find module 'pixelmatch'",
			},
		]);
	});

	it("passes a load that answered with its commands and failed nothing", () => {
		expect(
			readLoad(`{"type":"extension_ui_request"}\n${ANSWER}`, "", 0),
		).toEqual({ ok: true, failures: [], commands: 2 });
	});

	it("fails a load with failures, whatever pi exited with", () => {
		const report = readLoad("", PI_FAILURE, 1);
		expect(report.ok).toBe(false);
		expect(report.failures).toHaveLength(2);
	});

	it("fails a pi that exited badly, with the first thing it said", () => {
		expect(readLoad("", "TypeError: boom\n  at x", 1)).toMatchObject({
			ok: false,
			problem: "pi exited with 1: TypeError: boom",
		});
	});

	it("fails a pi that exited cleanly without answering", () => {
		expect(readLoad("", "", 0)).toMatchObject({
			ok: false,
			problem: "pi never answered",
		});
	});

	it("loads the package and nothing else, with no session and no network", () => {
		expect(loadCheckArgs("/t")).toEqual(
			expect.arrayContaining([
				"--no-extensions",
				"--no-session",
				"--offline",
				"--extension",
				"/t",
			]),
		);
	});

	it("lists the failures one to a line", () => {
		expect(describeLoad(readLoad("", PI_FAILURE, 1), "~/tree")).toBe(
			[
				"~/tree does not load.",
				"- /t/extensions/advisor/index.ts: Cannot find module '@jitsusama/agentic-harness.core/advisor'",
				"- /t/extensions/browser/index.ts: Cannot find module 'pixelmatch'",
			].join("\n"),
		);
	});
});

describe("asking a pi", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "load-check-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** A stand-in pi entry script with this body. */
	function fakePi(body: string): { node: string; entry: string } {
		const entry = join(dir, "pi.mjs");
		writeFileSync(entry, body);
		return { node: process.execPath, entry };
	}

	it("sends one request, waits for stdin to close, and reads the answer", async () => {
		const pi = fakePi(`
			let input = "";
			process.stdin.on("data", (c) => { input += c; });
			process.stdin.on("end", () => {
				const asked = JSON.parse(input.trim());
				process.stdout.write(JSON.stringify({ id: asked.id, type: "response", success: true, data: { commands: [1, 2, 3] } }) + "\\n");
			});
		`);
		expect(await checkLoad(pi, "/t")).toEqual({
			ok: true,
			failures: [],
			commands: 3,
		});
	});

	it("reports the failures a pi writes and its exit", async () => {
		const pi = fakePi(
			`process.stderr.write(${JSON.stringify(PI_FAILURE)}); process.exit(1);`,
		);
		const report = await checkLoad(pi, "/t");
		expect(report.ok).toBe(false);
		expect(report.failures.map((failure) => failure.error)).toContain(
			"Cannot find module 'pixelmatch'",
		);
	});

	it("gives up on a pi that never finishes loading", async () => {
		const pi = fakePi("setInterval(() => {}, 1000);");
		const report = await checkLoad(pi, "/t", 300);
		expect(report).toMatchObject({
			ok: false,
			problem: "pi was still loading after 1s",
		});
	});

	it("says when pi cannot be started at all", async () => {
		const report = await checkLoad(
			{ node: join(dir, "no-such-node"), entry: "x" },
			"/t",
		);
		expect(report.ok).toBe(false);
		expect(report.problem).toMatch(/^pi would not start/);
	});
});

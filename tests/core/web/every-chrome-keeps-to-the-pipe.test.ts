/**
 * Every Chrome the harness starts answers DevTools over its pipe alone,
 * and one an older harness started with a port is not handed out again.
 *
 * The warm browser's own case starts a real Chrome; this one holds every
 * other launch to the same rule, so a new launch site can't bring a port
 * back unseen, as the Slack sign-in's once did.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser } from "puppeteer-core";
import { describe, expect, it } from "vitest";
import { keepsToThePipe } from "../../../lib/core/web/browser/shared.ts";

const root = path.resolve(import.meta.dirname, "../../..");

function sources(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory())
			return entry.name === "node_modules" ? [] : sources(full);
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}

const code = ["lib", "extensions"]
	.flatMap((dir) => sources(path.join(root, dir)))
	.map((file) => ({
		file: path.relative(root, file),
		text: fs.readFileSync(file, "utf8"),
	}));

function browserStartedWith(spawnargs: string[]): Browser {
	return { process: () => ({ spawnargs }) } as unknown as Browser;
}

describe("every Chrome the harness starts", () => {
	it("is launched over the pipe wherever puppeteer launches one", () => {
		const launchers = code.filter(({ text }) => /\)?\.launch\(\{/.test(text));
		expect(launchers.map(({ file }) => file).sort()).toEqual([
			"lib/core/web/browser/launch.ts",
			"lib/slack/auth/browser-extract.ts",
		]);
		for (const { file, text } of launchers) {
			expect(text, file).toContain('"--remote-debugging-pipe"');
			expect(text, file).toMatch(/\bpipe: true\b/);
			expect(text, file).not.toContain('"--remote-debugging-port');
		}
	});

	it("is never given a DevTools port", () => {
		// Only a port given a value starts one; the flag's bare name is
		// how the held browser's check looks for it.
		expect(
			code
				.filter(({ text }) => text.includes("--remote-debugging-port="))
				.map(({ file }) => file),
		).toEqual([]);
	});
});

describe("a held browser", () => {
	it("is kept when it was started over the pipe alone", () => {
		expect(
			keepsToThePipe(
				browserStartedWith(["--headless=new", "--remote-debugging-pipe"]),
			),
			"a browser started over the pipe alone should be kept",
		).toBe(true);
	});

	it("is retired when an older harness started it with a port", () => {
		expect(
			keepsToThePipe(
				browserStartedWith(["--headless=new", "--remote-debugging-port=0"]),
			),
			"a browser started with a port should be retired",
		).toBe(false);
	});

	it("is retired when it was started with both", () => {
		expect(
			keepsToThePipe(
				browserStartedWith([
					"--remote-debugging-pipe",
					"--remote-debugging-port=0",
				]),
			),
			"a browser started with both the pipe and a port should be retired",
		).toBe(false);
	});
});

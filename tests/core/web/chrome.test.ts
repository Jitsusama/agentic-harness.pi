import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { findChrome, resolveChromePath } from "../../../lib/core/web/chrome.ts";

describe("findChrome", () => {
	it("finds Chrome on the search path when it isn't installed in a fixed place", () => {
		// NixOS keeps programs in the store and links them onto PATH,
		// so none of the installed paths exist there.
		const there = "/run/current-system/sw/bin/google-chrome-stable";
		expect(
			findChrome("/bin:/run/current-system/sw/bin", (p) => p === there),
		).toBe(there);
	});

	it("finds Chromium on the search path too", () => {
		const there = "/home/me/.nix-profile/bin/chromium";
		expect(findChrome("/home/me/.nix-profile/bin", (p) => p === there)).toBe(
			there,
		);
	});

	it("finds a Mac's Chrome in Applications, or in the person's own", () => {
		const system =
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		expect(findChrome("", (p) => p === system)).toBe(system);
		const own = `${os.homedir()}/Applications/Chromium.app/Contents/MacOS/Chromium`;
		expect(findChrome("", (p) => p === own)).toBe(own);
	});

	it("prefers an installed Chrome over one on the search path", () => {
		const installed = "/usr/bin/google-chrome";
		const onPath = "/opt/bin/google-chrome-stable";
		expect(findChrome("/opt/bin", (p) => p === installed || p === onPath)).toBe(
			installed,
		);
	});

	it("ignores the empty entries a stray colon leaves in PATH", () => {
		// An empty entry means the working directory, which is no place
		// to pick a browser up from.
		expect(() => findChrome(":", (p) => p === "google-chrome")).toThrow(
			/Chrome not found/,
		);
	});

	it("says what to do when there is no Chrome anywhere", () => {
		expect(() => findChrome("/bin", () => false)).toThrow(/set CHROME_PATH/);
	});
});

describe("resolveChromePath", () => {
	it("refuses a configured path that is not there, without retrying", () => {
		// CHROME_PATH was taken on trust, so a stale value fell into
		// the launch loop and came back after three attempts under a
		// headline blaming a Chrome auto-update. A path that does not
		// exist is a settled misconfig: say so, once, and name it.
		expect(() => resolveChromePath("/nope/chrome", () => false)).toThrow(
			/\/nope\/chrome, which does not exist/,
		);
	});

	it("names CHROME_PATH in the refusal so the reader knows what to fix", () => {
		expect(() => resolveChromePath("/nope/chrome", () => false)).toThrow(
			/CHROME_PATH/,
		);
	});

	it("takes a configured path that is there", () => {
		expect(resolveChromePath("/opt/chrome", () => true)).toBe("/opt/chrome");
	});

	it("falls back to discovery when nothing is configured", () => {
		// Undefined means "find it yourself", which must not be read as
		// a configured path that happens to be missing: the two have
		// different causes and different fixes, so they must not share
		// a message. Asserting on the message rather than on whether
		// this machine has Chrome keeps the test true either way.
		try {
			expect(resolveChromePath(undefined)).toMatch(/\S/);
		} catch (error) {
			expect(String(error)).toMatch(/Chrome not found/);
			expect(String(error)).not.toMatch(/CHROME_PATH is set to/);
		}
	});
});

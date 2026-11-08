import { afterEach, describe, expect, it, vi } from "vitest";
import setup from "./chrome-present.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("the browser lane's check for Chrome", () => {
	it("fails the lane, naming the path, where the configured Chrome is missing", () => {
		vi.stubEnv("CHROME_PATH", "/nowhere/chrome-that-is-not-here");
		expect(() => setup()).toThrow(
			/The browser lane drives a real Chrome\..*\/nowhere\/chrome-that-is-not-here/s,
		);
	});
});

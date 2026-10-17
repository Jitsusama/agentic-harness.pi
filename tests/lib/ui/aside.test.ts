/**
 * An aside is said through pi's notices while there is a screen, and
 * nothing in the harness writes to the terminal behind pi's renderer.
 */

import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asideFor } from "../../../lib/ui/aside.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("an aside", () => {
	it("is a notice when the session has a screen", () => {
		const told: [string, string | undefined][] = [];
		const written = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const say = asideFor({
			hasUI: true,
			ui: {
				notify: (text: string, level?: string) => told.push([text, level]),
			},
		} as never);
		say("a sweep could not run");
		say("a round was stopped", "info");
		expect(told).toEqual([
			["a sweep could not run", "warning"],
			["a round was stopped", "info"],
		]);
		expect(written).not.toHaveBeenCalled();
	});

	it("goes to standard error when there is no screen to draw over", () => {
		const lines: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			lines.push(String(chunk));
			return true;
		});
		asideFor({ hasUI: false } as never)("a sweep could not run");
		expect(lines).toEqual(["a sweep could not run\n"]);
	});

	it("says nothing rather than write over the screen that replaced its own", () => {
		const written = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const say = asideFor({
			hasUI: true,
			ui: {
				notify: () => {
					throw new Error("this context is stale");
				},
			},
		} as never);
		expect(() => say("a sweep could not run")).not.toThrow();
		expect(written).not.toHaveBeenCalled();
	});
});

describe("the harness", () => {
	it("never writes to the console, which lands in pi's editor", () => {
		// A line written behind pi's renderer appears inside the editor box
		// and leaves rows pi thinks it drew gone or doubled, the status line
		// among them, until something redraws the screen.
		let found = "";
		try {
			found = execFileSync(
				"git",
				[
					"grep",
					"-n",
					"-E",
					"console\\.(log|info|warn|error|debug)\\(",
					"--",
					"extensions/**/*.ts",
					"lib/**/*.ts",
				],
				{ encoding: "utf8" },
			).trim();
		} catch (error) {
			// git grep answers 1 when it finds nothing, which is the pass.
			if (Reflect.get(Object(error), "status") !== 1) throw error;
		}
		expect(found).toBe("");
	});
});

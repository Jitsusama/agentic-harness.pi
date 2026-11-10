/**
 * The shell a session forks once for its clipboard reads: it answers
 * each read with what the command printed, bytes intact, in the order
 * asked, and says plainly when it can't answer.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	type Helper,
	readDirectly,
	startHelper,
} from "../../../../lib/internal/clipboard/helper.ts";

const started: Helper[] = [];

function helper(shell?: string): Helper {
	const one = startHelper(shell);
	started.push(one);
	return one;
}

afterEach(() => {
	for (const one of started.splice(0)) one.stop();
});

describe("the clipboard helper", () => {
	it("answers with what the command printed", async () => {
		const said = await helper().read(["printf", "%s", "it's pasted"], 2_000);
		expect(said?.toString("utf8")).toBe("it's pasted");
	});

	it("keeps every byte, newlines and all", async () => {
		const said = await helper().read(["printf", "\\001\\377\\n\\n"], 2_000);
		expect([...(said ?? [])]).toEqual([1, 255, 10, 10]);
	});

	it("answers reads in the order they were asked", async () => {
		const shell = helper();
		const said = await Promise.all(
			["one", "two", "three"].map((word) =>
				shell.read(["printf", "%s", word], 2_000),
			),
		);
		expect(said.map((one) => one?.toString("utf8"))).toEqual([
			"one",
			"two",
			"three",
		]);
	});

	it("answers empty for a command that fails or runs past its limit", async () => {
		const shell = helper();
		const failed = await shell.read(["false"], 2_000);
		// A command outlasting its limit is what this reads; `timeout` ends it.
		const slow = await shell.read(["sleep", "30"], 100);
		expect({
			failed: failed?.length,
			slow: slow?.length,
			alive: shell.alive(),
		}).toEqual({ failed: 0, slow: 0, alive: true });
	});

	it("answers nothing once stopped, so the caller reads another way", async () => {
		const shell = helper();
		shell.stop();
		const said = await shell.read(["printf", "%s", "late"], 2_000);
		expect({ said, alive: shell.alive() }).toEqual({
			said: undefined,
			alive: false,
		});
	});

	it("answers nothing when its shell never started", async () => {
		const shell = helper("/no/such/shell");
		const said = await shell.read(["printf", "%s", "never"], 2_000);
		expect({ said, alive: shell.alive() }).toEqual({
			said: undefined,
			alive: false,
		});
	});
});

describe("reading directly", () => {
	it("answers with what the command printed, or nothing when it failed", async () => {
		const printed = await readDirectly(["printf", "%s", "direct"], 2_000);
		const failed = await readDirectly(["false"], 2_000);
		const missing = await readDirectly(["/no/such/command"], 2_000);
		expect({
			printed: printed?.toString("utf8"),
			failed,
			missing,
		}).toEqual({ printed: "direct", failed: undefined, missing: undefined });
	});
});

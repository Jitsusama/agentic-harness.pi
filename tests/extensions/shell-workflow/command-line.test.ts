/**
 * A command kept off its shell's command line, through pi's own bash.
 *
 * With `bash -c <command>`, `pkill -f` with a pattern from the command
 * killed the shell running it, and `pgrep -f` counted that shell as a
 * match. These run real commands, since what is checked is what the
 * kernel shows as each process's command line.
 */

import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	COMMAND_STUB,
	COMMAND_VARIABLE,
	offCommandLine,
} from "../../../extensions/shell-workflow/command-line.ts";
import { withoutInteraction } from "../../../extensions/shell-workflow/environment.ts";

const bash = createBashToolDefinition(process.cwd(), {
	spawnHook: (context) => offCommandLine(withoutInteraction(context)),
	exposeSessionEnvironment: false,
});

/** Run a command as the agent's bash does; its text, or the error's. */
async function run(command: string): Promise<string> {
	try {
		const result = await bash.execute(
			"t",
			{ command },
			undefined,
			undefined,
			undefined as never,
		);
		return result.content[0]?.type === "text" ? result.content[0].text : "";
	} catch (error) {
		return (error as Error).message;
	}
}

describe("the hook", () => {
	it("hands the shell a fixed stub and the command in its environment", () => {
		const moved = offCommandLine({
			command: "echo hi",
			cwd: "/w",
			env: { KEEP: "1" },
		});

		expect(moved).toEqual({
			command: COMMAND_STUB,
			cwd: "/w",
			env: { KEEP: "1", [COMMAND_VARIABLE]: "echo hi" },
		});
	});
});

describe("a command whose shell no longer carries it", () => {
	it("survives a pkill -f of a pattern it names, which kills only the target", async () => {
		const said = await run(
			[
				"sleep 271 & target=$!",
				"pkill -f 'sleep 271'",
				'wait $target; echo "target ended $?"',
				"echo survived",
			].join("\n"),
		);

		expect(said).toContain("target ended 143");
		expect(said).toContain("survived");
	});

	it("is not among what pgrep -f finds for it", async () => {
		const said = await run(
			[
				"sleep 272 & target=$!",
				"found=$(pgrep -f 'sleep 272' | tr '\\n' ' ')",
				'kill $target; echo "found [$found] target [$target ]"',
			].join("\n"),
		);

		const [, found, target] =
			said.match(/found \[(.*)\] target \[(.*)\]/) ?? [];
		expect(found).toBe(target);
	});

	it("leaves no copy of itself to what it starts", async () => {
		const said = await run(
			`bash -c 'echo "child sees [\${${COMMAND_VARIABLE}-}]"'`,
		);

		expect(said).toContain("child sees []");
	});

	it("keeps its exit code, set -e and its line numbers", async () => {
		expect(await run("echo one\nexit 7")).toMatch(/one[\s\S]*code 7/);
		expect(await run("set -e\nfalse\necho not-reached")).not.toContain(
			"not-reached",
		);
		expect(await run("true\nnosuchcommand-here")).toContain(
			"line 2: nosuchcommand-here",
		);
	});
});

/**
 * The review tools' commands run unattended unless a test says otherwise.
 *
 * Every other review test puts a stub in the seam, so this is the one
 * that shows what is there when nothing has: a runner whose git cannot
 * prompt, rather than pi's exec, whose git drew its prompt over pi.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	REVIEW_COMMANDS,
	reviewExec,
	runCommandsWith,
} from "../../extensions/review-integration/commands.ts";

const ASKS = 'echo "$GIT_TERMINAL_PROMPT $GH_PROMPT_DISABLED"';

describe("the review tools' commands", () => {
	afterEach(() => runCommandsWith(undefined));

	it("tell git and gh not to ask, by default", async () => {
		runCommandsWith(undefined);

		const host = await REVIEW_COMMANDS.exec("sh", ["-c", ASKS]);
		const library = await reviewExec("sh", ["-c", ASKS]);

		expect(host.stdout.trim()).toBe("0 1");
		expect(library.stdout.trim()).toBe("0 1");
	});

	it("go wherever a test puts them, engine and providers included", async () => {
		const seen: string[] = [];
		runCommandsWith({
			exec: async (command, args) => {
				seen.push([command, ...args].join(" "));
				return { code: 0, stdout: "stubbed", stderr: "", killed: false };
			},
		});

		const said = await reviewExec("git", ["status"]);

		expect(said.stdout).toBe("stubbed");
		expect(seen).toEqual(["git status"]);
	});
});

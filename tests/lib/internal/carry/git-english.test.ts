/**
 * Which of carrying's commands run in English: git, itself or through
 * env, and nothing else.
 */

import { describe, expect, it } from "vitest";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import { gitInEnglish } from "../../../../lib/internal/carry/git-english.ts";

/** Which of the two execs ran each command, by the command's words. */
function routed() {
	const ran: string[] = [];
	const by =
		(which: string): Exec =>
		async (command, args) => {
			ran.push(`${which}: ${[command, ...args].join(" ")}`);
			return { code: 0, stdout: "", stderr: "" };
		};
	return { ran, exec: gitInEnglish(by("english"), by("as it is")) };
}

describe("carrying's commands", () => {
	it("run git in English, itself or through env's settings", async () => {
		const { ran, exec } = routed();

		await exec("git", ["status"]);
		await exec("env", ["GIT_INDEX_FILE=/tmp/index", "git", "-C", "t", "add"]);

		expect(ran).toEqual([
			"english: git status",
			"english: env GIT_INDEX_FILE=/tmp/index git -C t add",
		]);
	});

	it("run anything else as it is, env running something else included", async () => {
		const { ran, exec } = routed();

		await exec("lsof", ["-F", "n"]);
		await exec("env", ["A=1", "sh", "-c", "git status"]);
		await exec("env", []);

		expect(ran).toEqual([
			"as it is: lsof -F n",
			"as it is: env A=1 sh -c git status",
			"as it is: env",
		]);
	});
});

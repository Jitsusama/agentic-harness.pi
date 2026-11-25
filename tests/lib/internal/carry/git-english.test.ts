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
		await exec("env", ["-u", "GIT_DIR", "-i", "A=1", "--", "git", "log"]);

		expect(ran).toEqual([
			"english: git status",
			"english: env GIT_INDEX_FILE=/tmp/index git -C t add",
			"english: env -u GIT_DIR -i A=1 -- git log",
		]);
	});

	it("run git in English through env's split string, macOS's options, or by its path", async () => {
		const { ran, exec } = routed();

		await exec("env", ["-S", "A=1 git", "status"]);
		await exec("env", ["-S", "A=1", "git", "log"]);
		await exec("env", ["-P", "/usr/bin", "git", "log"]);
		await exec("/usr/bin/env", ["/usr/bin/git", "log"]);
		await exec("env", ["-S", "sh -c", "git"]);
		await exec("env", ["-P", "git", "sh"]);

		expect(ran).toEqual([
			"english: env -S A=1 git status",
			"english: env -S A=1 git log",
			"english: env -P /usr/bin git log",
			"english: /usr/bin/env /usr/bin/git log",
			"as it is: env -S sh -c git",
			"as it is: env -P git sh",
		]);
	});

	it("run anything else as it is, env running something else included", async () => {
		const { ran, exec } = routed();

		await exec("lsof", ["-F", "n"]);
		await exec("env", ["A=1", "sh", "-c", "git status"]);
		await exec("env", []);
		await exec("env", ["-u", "git", "sh"]);

		expect(ran).toEqual([
			"as it is: lsof -F n",
			"as it is: env A=1 sh -c git status",
			"as it is: env",
			"as it is: env -u git sh",
		]);
	});
});

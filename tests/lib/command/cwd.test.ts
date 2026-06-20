import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveCwd, tokenize } from "../../../lib/command/index.js";

describe("effectiveCwd", () => {
	it("returns the base cwd when the command has no cd", () => {
		const result = effectiveCwd(tokenize("git status"), "/repo");

		expect(result).toEqual({ dir: "/repo" });
	});

	it("ignores a cd that appears after the bounded position", () => {
		const line = tokenize("cd /before && git commit -F m.txt && cd /after");
		const commit = line.commands.find((c) => c.argv[1]?.text === "commit");

		expect(effectiveCwd(line, "/repo", commit?.span.start)).toEqual({
			dir: "/before",
		});
	});

	it("resolves an absolute cd by replacing the running dir", () => {
		expect(effectiveCwd(tokenize("cd /abs && git status"), "/repo")).toEqual({
			dir: "/abs",
		});
	});

	it("resolves a relative cd against the running dir", () => {
		expect(effectiveCwd(tokenize("cd sub && git status"), "/repo")).toEqual({
			dir: "/repo/sub",
		});
	});

	it("composes chained cd segments", () => {
		expect(
			effectiveCwd(tokenize("cd /a && cd b && cd ../c && git status"), "/repo"),
		).toEqual({ dir: "/a/c" });
	});

	it("expands ~ to the home directory", () => {
		expect(effectiveCwd(tokenize("cd ~ && git status"), "/repo")).toEqual({
			dir: homedir(),
		});
		expect(effectiveCwd(tokenize("cd ~/sub && git status"), "/repo")).toEqual({
			dir: join(homedir(), "sub"),
		});
	});

	it("strips quotes from a literal cd target", () => {
		expect(effectiveCwd(tokenize("cd 'a b' && git status"), "/repo")).toEqual({
			dir: "/repo/a b",
		});
	});

	it("reports unresolvable for a variable expansion target", () => {
		const result = effectiveCwd(tokenize("cd $HOME && git status"), "/repo");

		expect("unresolvable" in result && result.unresolvable).toBe(true);
	});
});

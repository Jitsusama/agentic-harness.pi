import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { budgetFileProvider, parseBudgetFile } from "../../../lib/budget/files";

let folder: string;
beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "budgets-"));
});
afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

describe("a budget file", () => {
	it("reads KEY=value lines, a label, quotes and export, passing comments over", () => {
		expect(
			parseBudgetFile(
				[
					"# label: Acme's workspace",
					"# a comment",
					"",
					"ANTHROPIC_API_KEY=sk-1",
					'export QUOTED="a b"',
					"SINGLE='c'",
				].join("\n"),
			),
		).toEqual({
			env: { ANTHROPIC_API_KEY: "sk-1", QUOTED: "a b", SINGLE: "c" },
			label: "Acme's workspace",
			unread: [],
		});
	});

	it("names the lines that are not KEY=value", () => {
		expect(parseBudgetFile("GOOD=1\nnot a line\n9BAD=2").unread).toEqual([
			2, 3,
		]);
	});
});

describe("the file provider", () => {
	it("draws on <name>.env, labelled by the file or by the name", async () => {
		writeFileSync(join(folder, "acme.env"), "# label: Acme\nKEY=one\n");
		writeFileSync(join(folder, "plain.env"), "KEY=two\n");
		const files = budgetFileProvider(folder);

		expect(await files.resolve("acme")).toEqual({
			kind: "drawn",
			env: { KEY: "one" },
			label: "Acme",
		});
		expect(await files.resolve("plain")).toEqual({
			kind: "drawn",
			env: { KEY: "two" },
			label: "plain",
		});
	});

	it("runs an executable <name> and reads what it prints", async () => {
		const program = join(folder, "minted");
		writeFileSync(program, "#!/bin/sh\necho KEY=fresh\n");
		chmodSync(program, 0o755);

		expect(await budgetFileProvider(folder).resolve("minted")).toEqual({
			kind: "drawn",
			env: { KEY: "fresh" },
			label: "minted",
		});
	});

	it("says a program that fails can't be drawn on, naming it", async () => {
		const program = join(folder, "broken");
		writeFileSync(program, "#!/bin/sh\nexit 3\n");
		chmodSync(program, 0o755);

		const answer = await budgetFileProvider(folder).resolve("broken");

		expect(answer.kind).toBe("unavailable");
		expect(answer.kind === "unavailable" && answer.reason).toContain(program);
	});

	it("leaves a name with no file to the next provider", async () => {
		expect(await budgetFileProvider(folder).resolve("delta")).toEqual({
			kind: "unknown",
		});
	});

	it("refuses a file that sets nothing or has a line it can't read", async () => {
		writeFileSync(join(folder, "empty.env"), "# nothing\n");
		writeFileSync(join(folder, "typo.env"), "KEY=1\nKEY 2\n");
		const files = budgetFileProvider(folder);

		const empty = await files.resolve("empty");
		const typo = await files.resolve("typo");

		expect(empty.kind === "unavailable" && empty.reason).toContain(
			"sets no variables",
		);
		expect(typo.kind === "unavailable" && typo.reason).toContain("(2)");
	});
});

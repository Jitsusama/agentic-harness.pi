import { execFileSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	mkdtempSync,
	open,
	openSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	budgetFileProvider,
	parseBudgetFile,
} from "../../../lib/budget/files.ts";

/** Every thread of libuv's pool: four unless the process was given more. */
const POOL_THREADS = Number(process.env.UV_THREADPOOL_SIZE) || 4;
/** Far longer than a read of a few lines takes, held pool or not. */
const ANSWER_WITHIN_MS = 2_000;
/** Past the 64 KiB a budget file may hold. */
const TOO_LARGE = 70 * 1024;

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

	it("answers while libuv's pool is busy, not queued behind its work", async () => {
		writeFileSync(join(folder, "acme.env"), "KEY=one\n");
		// Each opening of a pipe nobody writes to holds a pool thread, idle,
		// as a busy pi host's queued reads do: a read sent through the pool
		// waits behind them.
		const pipe = join(folder, "held");
		execFileSync("mkfifo", [pipe]);
		const held = Array.from(
			{ length: POOL_THREADS },
			() =>
				new Promise<void>((done) =>
					open(pipe, "r", (_, fd) => {
						if (fd !== undefined) closeSync(fd);
						done();
					}),
				),
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let first: unknown;
		try {
			first = await Promise.race([
				budgetFileProvider(folder).resolve("acme"),
				new Promise<string>((done) => {
					timer = setTimeout(() => done("the clock"), ANSWER_WITHIN_MS);
				}),
			]);
		} finally {
			clearTimeout(timer);
			// Opened to read and write, the pipe has a writer, which lets every
			// held opening go, and kept open until each has, late or not.
			const writer = openSync(pipe, "r+");
			await Promise.all(held);
			closeSync(writer);
		}

		expect(
			first,
			"the budget's drawing, while every pool thread is held",
		).toEqual({
			kind: "drawn",
			env: { KEY: "one" },
			label: "acme",
		});
	});

	it("refuses a budget file that is a pipe, at once and saying why", async () => {
		// Read at once, a pipe nobody writes to would hold the host's loop
		// with no deadline to end it.
		const pipe = join(folder, "piped.env");
		execFileSync("mkfifo", [pipe]);

		const answer = await budgetFileProvider(folder).resolve("piped");

		expect(answer, "a pipe, refused as no plain file").toEqual({
			kind: "unavailable",
			reason: `${pipe} isn't a plain file.`,
		});
	});

	it("refuses a budget file far larger than a few lines", async () => {
		const file = join(folder, "huge.env");
		writeFileSync(file, `KEY=${"x".repeat(TOO_LARGE)}\n`);

		expect(
			await budgetFileProvider(folder).resolve("huge"),
			"a file too large to be a budget's, refused",
		).toEqual({
			kind: "unavailable",
			reason: `${file} is larger than a budget file is.`,
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

	it("says once which program failed, then how and what it wrote to stderr", async () => {
		const program = join(folder, "locked");
		writeFileSync(
			program,
			"#!/bin/sh\necho 'the vault is locked' >&2\nexit 3\n",
		);
		chmodSync(program, 0o755);

		const answer = await budgetFileProvider(folder).resolve("locked");

		expect(answer).toEqual({
			kind: "unavailable",
			reason: `${program} failed (exit 3): the vault is locked.`,
		});
	});

	it("never makes a path of a name that could leave its folder", async () => {
		const outside = join(folder, "..", `${folder.split("/").pop()}-escape`);
		writeFileSync(`${outside}.env`, "KEY=stolen\n");
		try {
			expect(
				await budgetFileProvider(folder).resolve(
					`../${outside.split("/").pop()}`,
				),
			).toEqual({ kind: "unknown" });
		} finally {
			rmSync(`${outside}.env`, { force: true });
		}
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

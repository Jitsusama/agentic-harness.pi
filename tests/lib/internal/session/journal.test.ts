import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	journalCommand,
	sayInJournal,
} from "../../../../lib/internal/session/journal.ts";

describe("journalCommand", () => {
	it("writes to the journal where systemd-cat is, at the level asked", () => {
		const command = journalCommand("err", (program) =>
			program === "systemd-cat" ? "/store/systemd-cat" : "/usr/bin/logger",
		);
		expect(command, "systemd-cat, tagged pi, at err").toEqual({
			program: "/store/systemd-cat",
			args: ["-t", "pi", "-p", "err"],
		});
	});

	it("writes through logger where there is no journal, as a user's line", () => {
		const command = journalCommand("info", (program, folders) =>
			program === "logger" && folders.includes("/usr/bin")
				? "/usr/bin/logger"
				: undefined,
		);
		expect(command, "logger, tagged pi, at user.info").toEqual({
			program: "/usr/bin/logger",
			args: ["-t", "pi", "-p", "user.info"],
		});
	});

	it("writes nowhere when neither is the system's", () => {
		expect(
			journalCommand("info", () => undefined),
			"no command without a log to write to",
		).toBeUndefined();
	});
});

describe("sayInJournal", () => {
	it("hands its line to the log's program and returns before it ends", async () => {
		const folder = mkdtempSync(join(tmpdir(), "journal-"));
		const heard = join(folder, "heard");
		const program = join(folder, "cat-to-file");
		writeFileSync(
			program,
			`#!/bin/sh\necho "$@" > "${heard}.args"\ncat > "${heard}"\n`,
		);
		chmodSync(program, 0o755);

		sayInJournal("pi: ready in 812 ms", { program, args: ["-t", "pi"] });

		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			try {
				if (readFileSync(heard, "utf8") !== "") break;
			} catch {
				// Not written yet: the program runs on after the call returns.
			}
			// Polls the file the program writes, since the call doesn't wait.
			await new Promise((done) => setTimeout(done, 20));
		}
		expect(readFileSync(heard, "utf8"), "the line, as given").toBe(
			"pi: ready in 812 ms",
		);
		expect(readFileSync(`${heard}.args`, "utf8").trim(), "its arguments").toBe(
			"-t pi",
		);
	});

	it("survives a log program that isn't there", () => {
		expect(
			() => sayInJournal("lost", { program: "/nowhere/systemd-cat", args: [] }),
			"a missing program costs only the line",
		).not.toThrow();
	});
});

/**
 * A refusal leaves one line of a fixed shape in the system's log, which
 * never holds what was asked for, and the refused call says so when the
 * log didn't take it. A stand-in logger writes what it was given to a
 * file, so nothing reaches the machine's real log.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FENCE_LOG_TAG,
	type Refusal,
	recordedInShell,
	recordRefusal,
	recordUnfenced,
	refusalLine,
	unfencedLine,
} from "../../../lib/internal/fence-log.ts";

let folder: string;
let logger: string;
let written: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "fence-log-"));
	logger = join(folder, "logger");
	written = join(folder, "written");
	writeFileSync(
		logger,
		`#!/bin/sh\nfor word in "$@"; do printf '%s\\n' "$word"; done > '${written}'\n`,
	);
	chmodSync(logger, 0o755);
});

afterEach(() => rmSync(folder, { recursive: true, force: true }));

const refusal: Refusal = {
	kind: "path",
	tool: "read",
	sandbox: "fence",
	session: "01a1d112-2f75-7372-a3b5-65076f20ad6c",
};

describe("a refusal's line", () => {
	it("names the kind, tool, sandbox and session, and nothing asked for", () => {
		expect(refusalLine(refusal), "the line's fixed shape").toBe(
			"refused kind=path tool=read sandbox=fence session=01a1d112-2f75-7372-a3b5-65076f20ad6c",
		);
	});

	it("keeps its shape whatever a value holds", () => {
		const line = refusalLine({
			kind: "program",
			tool: "bash kind=path",
			sandbox: undefined,
			session: "",
		});
		expect(line, "a value with a space bent the shape").toBe(
			"refused kind=program tool=unknown sandbox=unknown session=unknown",
		);
	});
});

describe("recording a refusal from pi's process", () => {
	it("hands the logger the tag and the line", async () => {
		const why = await recordRefusal(refusal, logger);
		expect(why, "the logger took it, so nothing is added").toBeUndefined();
		const words = readFileSync(written, "utf8").trim().split("\n");
		expect(words, "what the logger was given").toEqual([
			"-t",
			FENCE_LOG_TAG,
			"-p",
			"auth.notice",
			"--",
			refusalLine(refusal),
		]);
	});

	it("says why when the log didn't take it", async () => {
		writeFileSync(logger, "#!/bin/sh\nexit 3\n");
		const why = await recordRefusal(refusal, logger);
		expect(why, "a failed logger said nothing").toContain(
			"The system log didn't take this refusal",
		);
	});

	it("says why when there is no logger", async () => {
		const why = await recordRefusal(refusal, undefined);
		expect(why, "a missing logger said nothing").toContain("no logger");
	});
});

describe("a session running unfenced", () => {
	it("says off when it chose to, and none when it couldn't be had", () => {
		expect(unfencedLine("off", "s-1"), "an opt-out's line").toBe(
			"unfenced sandbox=off session=s-1",
		);
		expect(unfencedLine(undefined, "s-1"), "no fence to be had").toBe(
			"unfenced sandbox=none session=s-1",
		);
		expect(
			unfencedLine("off now", undefined),
			"a value with a space bent the shape",
		).toBe("unfenced sandbox=unknown session=unknown");
	});

	it("hands the logger the tag and the line", async () => {
		const why = await recordUnfenced("off", "s-1", logger);
		expect(why, "the logger took it, so nothing is added").toBeUndefined();
		const words = readFileSync(written, "utf8").trim().split("\n");
		expect(words, "what the logger was given").toEqual([
			"-t",
			FENCE_LOG_TAG,
			"-p",
			"auth.notice",
			"--",
			"unfenced sandbox=off session=s-1",
		]);
	});

	it("says why when there is no logger", async () => {
		const why = await recordUnfenced("off", "s-1", undefined);
		expect(why, "a missing logger said nothing").toContain("no logger");
	});
});

describe("recording a refusal in a refused command's shell", () => {
	/** What `text` prints on stderr and the logger was given. */
	function ran(text: string): { said: string; given: string } {
		const said = execFileSync("bash", ["-c", `{ ${text}; } 2>&1`], {
			encoding: "utf8",
		});
		let given = "";
		try {
			given = readFileSync(written, "utf8");
		} catch {
			// The logger never ran, so it was given nothing.
		}
		return { said, given };
	}

	it("hands the logger the line and prints nothing", () => {
		const { said, given } = ran(recordedInShell(refusal, logger));
		expect(said, "a recorded refusal printed something").toBe("");
		expect(given, "what the logger was given").toContain(refusalLine(refusal));
	});

	it("says so on stderr when the log didn't take it", () => {
		writeFileSync(logger, "#!/bin/sh\nexit 3\n");
		const { said } = ran(recordedInShell(refusal, logger));
		expect(said, "a failed logger said nothing").toContain(
			"The system log didn't take this refusal.",
		);
	});

	it("says so when there is no logger", () => {
		const { said, given } = ran(recordedInShell(refusal, undefined));
		expect(given, "something ran as the logger").toBe("");
		expect(said, "a missing logger said nothing").toContain(
			"The system log didn't take this refusal.",
		);
	});
});

/**
 * A kept call's command moves into jobs itself, before it starts
 * anything. The keeping stub runs the command in a subshell, where `$$`
 * still names the stub's own shell, so on 14 November the move line
 * moved that shell again while the subshell, and the changed-checks,
 * nix-offload and ssh it started, stayed in the pi host's unit in
 * agents.slice (5FWIUS [b1ecaa70]).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	COMMAND_STUB,
	COMMAND_VARIABLE,
	KEEP_VARIABLE,
	KEEPING_STUB,
} from "../../../extensions/shell-workflow/command-line.ts";
import { shellMovesItself } from "../../../lib/internal/priority/place.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kept-placement-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Runs `stub` with a command that moves itself, then says its own pid. */
function placedThrough(stub: string): { moved: string; ran: string } {
	const procs = join(dir, "cgroup.procs");
	const ran = join(dir, "ran");
	const move = shellMovesItself(procs);
	expect(move, "a plain path has a move line").toBeDefined();
	execFileSync("bash", ["-c", stub], {
		env: {
			...process.env,
			[COMMAND_VARIABLE]: `${move}\necho "$BASHPID" > '${ran}'`,
			[KEEP_VARIABLE]: join(dir, "keep"),
		},
		stdio: "ignore",
	});
	return {
		moved: readFileSync(procs, "utf8").trim(),
		ran: readFileSync(ran, "utf8").trim(),
	};
}

describe("a command's move into jobs", () => {
	it("moves the shell that runs a kept command, not the stub around it", () => {
		const { moved, ran } = placedThrough(KEEPING_STUB);
		expect(moved, "the kept command's own shell is the one moved").toBe(ran);
	});

	it("moves the shell itself when the command runs in it", () => {
		const { moved, ran } = placedThrough(COMMAND_STUB);
		expect(moved, "the shell running the command is moved").toBe(ran);
	});
});

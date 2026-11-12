/**
 * Whether a call is on, from a stand-in for a-call-is-on that exits as
 * the real one does: 0 while a call is on, 1 while none is, 2 when it
 * can't tell.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { callIsOn } from "../../../lib/internal/calls.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "calls-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A stand-in that exits with `code`. */
function exitingWith(code: number): string {
	const program = join(dir, `a-call-is-on-${code}`);
	writeFileSync(program, `#!/bin/sh\nexit ${code}\n`);
	chmodSync(program, 0o755);
	return program;
}

it("says a call is on only when the program says so", async () => {
	expect([
		await callIsOn({ program: exitingWith(0) }),
		await callIsOn({ program: exitingWith(1) }),
		await callIsOn({ program: exitingWith(2) }),
	]).toEqual([true, false, false]);
});

it("counts no call on a machine without the program, saying so once", async () => {
	const missing = vi.fn();
	const program = join(dir, "missing");

	const said = [
		await callIsOn({ program, missing }),
		await callIsOn({ program, missing }),
	];

	expect([said, missing.mock.calls.length]).toEqual([[false, false], 1]);
	expect(missing.mock.calls[0]?.[0]).toMatch(/not on the PATH/);
});

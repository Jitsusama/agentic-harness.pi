/**
 * Whether a call is on, from a stand-in for a-call-is-on that exits as
 * the real one does: 0 while a call is on, 1 while none is, 2 when it
 * can't tell.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { callIsOn } from "../../../../lib/internal/cache/calls.ts";

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

it("counts no call from a program that won't stop when asked, at its time", async () => {
	const program = join(dir, "a-call-is-on-stuck");
	// It ignores SIGTERM and would say a call is on at 10 s.
	writeFileSync(program, "#!/bin/sh\ntrap '' TERM\nsleep 10\nexit 0\n");
	chmodSync(program, 0o755);
	const started = performance.now();

	const on = await callIsOn({ program });

	expect(on, "a program past its time says no call").toBe(false);
	expect(
		performance.now() - started,
		"answered at its time, not the program's end",
	).toBeLessThan(6_000);
}, 12_000);

it("counts no call on a machine without the program, saying so once", async () => {
	const cannotAsk = vi.fn();
	const program = join(dir, "missing");

	const said = [
		await callIsOn({ program, cannotAsk }),
		await callIsOn({ program, cannotAsk }),
	];

	expect([said, cannotAsk.mock.calls.length]).toEqual([[false, false], 1]);
	expect(cannotAsk.mock.calls[0]?.[0]).toMatch(/isn't on the PATH/);
});

it("counts no call from a program that refuses, or can't run, saying each once", async () => {
	const cannotAsk = vi.fn();
	const refusing = exitingWith(64);
	const unrunnable = join(dir, "a-call-is-on-unrunnable");
	writeFileSync(unrunnable, "#!/bin/sh\nexit 0\n");
	chmodSync(unrunnable, 0o644);

	const said = [
		await callIsOn({ program: refusing, cannotAsk }),
		await callIsOn({ program: refusing, cannotAsk }),
		await callIsOn({ program: unrunnable, cannotAsk }),
		await callIsOn({ program: unrunnable, cannotAsk }),
	];

	expect(said, "neither can say a call is on").toEqual([
		false,
		false,
		false,
		false,
	]);
	expect(
		cannotAsk.mock.calls.map(([why]) => why),
		"each reason once, saying what follows",
	).toEqual([
		`${refusing} refuses to answer with no arguments, so warms go whether or not a call is on`,
		`${unrunnable} can't be started (EACCES), so warms go whether or not a call is on`,
	]);
});

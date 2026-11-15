/**
 * What `runReviewer` checks a run against: a pi install that has gone
 * stale, before the spawn and in its stderr, and timeouts outside their
 * bounds.
 */

import { describe, expect, it } from "vitest";
import { review, assistantEvent, fakeRun } from "./fake-runs.ts";

describe("runReviewer: stale runtime detection", () => {
	it("refuses to spawn when the captured pi binary path is gone", async () => {
		// Pi was updated (nix gc, brew upgrade) mid-session.
		// The currently-running binary path no longer exists
		// on disk, so any subagent we spawn will hit ENOENT
		// loading parent-derived extension paths. Better to
		// short-circuit with a clear advisory than to burn a
		// retry-loop cycle producing the same crash.
		const { runPi, calls } = fakeRun({ stdout: assistantEvent("{}") });
		const result = await review(runPi, {
			checkRuntime: () => ({
				path: "/nix/store/old-pi/bin/pi",
				message:
					"Pi runtime stale: the running pi binary at " +
					"`/nix/store/old-pi/bin/pi` no longer exists. Restart pi.",
			}),
		});
		expect(calls).toHaveLength(0);
		expect(result.exitCode).toBe(127);
		expect(result.finalAssistantText).toBe("");
		expect(result.warnings).toContainEqual(
			expect.stringMatching(/^Pi runtime stale:/),
		);
		expect(result.stderr).toContain("/nix/store/old-pi/bin/pi");
	});

	it("detects the stale-install ENOENT shape in spawned stderr and adds a clear warning", async () => {
		// The pre-dispatch probe can miss paths it doesn't
		// know about (extension resolution, native binaries).
		// As a defensive layer, match the canonical ENOENT
		// shape post-spawn so the dispatcher still surfaces
		// a restart advisory instead of a generic retry hint.
		const { runPi } = fakeRun({
			stdout: "",
			stderr: [
				"node:fs:440",
				"Error: ENOENT: no such file or directory, open '/Users/x/.pi/pkg/pi-0.75.3/package.json'",
			].join("\n"),
			exitCode: 1,
		});
		const result = await review(runPi);
		const stale = result.warnings.find((w) =>
			w.startsWith("Pi runtime stale:"),
		);
		expect(stale).toBeDefined();
		expect(stale).toContain("/Users/x/.pi/pkg/pi-0.75.3");
		expect(stale).toMatch(/restart pi/i);
	});

	it("leaves an unrelated ENOENT stderr untouched (no false positive)", async () => {
		const { runPi } = fakeRun({
			stdout: "",
			stderr:
				"Error: ENOENT: no such file or directory, open '/tmp/missing.json'",
			exitCode: 1,
		});
		const result = await review(runPi);
		expect(result.warnings).not.toContainEqual(
			expect.stringMatching(/^Pi runtime stale:/),
		);
	});
});

describe("runReviewer: timeout validation", () => {
	// Per-call timeout overrides are public library input.
	// The tool schema enforces `minimum: 1000` at the fleet
	// boundary, but pr-workflow and any future library
	// consumer land in `runReviewer` directly. Validation
	// at the library boundary keeps the contract consistent
	// across entry points and turns nonsense values into
	// loud, early errors instead of supervisor confusion.

	it("rejects timeoutMs below the floor with a clear error", async () => {
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		await expect(
			review(runPi, {
				timeoutMs: 500,
			}),
		).rejects.toThrow(/Invalid timeoutMs.*below the 1000ms floor/);
	});

	it("rejects negative idleTimeoutMs with a clear error", async () => {
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		await expect(
			review(runPi, {
				idleTimeoutMs: -1,
			}),
		).rejects.toThrow(/Invalid idleTimeoutMs/);
	});

	it("rejects non-finite timeout values", async () => {
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		await expect(
			review(runPi, {
				timeoutMs: Number.POSITIVE_INFINITY,
			}),
		).rejects.toThrow(/must be a whole number of milliseconds/);
	});

	it("rejects non-integer timeout values", async () => {
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		await expect(
			review(runPi, {
				timeoutMs: 1500.5,
			}),
		).rejects.toThrow(/must be a whole number of milliseconds/);
	});

	it("rejects values above the 8-hour ceiling", async () => {
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		await expect(
			review(runPi, {
				timeoutMs: 9 * 60 * 60 * 1000,
			}),
		).rejects.toThrow(/past the.*ceiling/);
	});

	it("accepts a 6-hour timeout (within the 8-hour ceiling)", async () => {
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		const result = await review(runPi, {
			timeoutMs: 6 * 60 * 60 * 1000,
			idleTimeoutMs: 6 * 60 * 60 * 1000,
		});
		expect(result.finalAssistantText).toBe("ok");
	});

	it("rejects idleTimeoutMs greater than timeoutMs", async () => {
		// The wall clock would fire first regardless of how
		// patient the idle ceiling is. Catching the
		// inconsistency at the boundary surfaces the bug a
		// reader would only notice by watching their soak
		// run die at the 20-minute mark.
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		await expect(
			review(runPi, {
				timeoutMs: 5 * 60 * 1000,
				idleTimeoutMs: 10 * 60 * 1000,
			}),
		).rejects.toThrow(
			/idleTimeoutMs.*outlives timeoutMs.*wall clock fires first/,
		);
	});

	it("accepts valid timeout pairs within the bounds", async () => {
		// Sanity check: legitimate long-running overrides
		// pass validation untouched. The runner sees the
		// values; the library doesn't mutate them.
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		const result = await review(runPi, {
			timeoutMs: 45 * 60 * 1000,
			idleTimeoutMs: 15 * 60 * 1000,
		});
		expect(result.exitCode).toBe(0);
	});

	it("accepts undefined overrides (runner default applies)", async () => {
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		const result = await review(runPi);
		expect(result.exitCode).toBe(0);
	});
});

import { describe, expect, it } from "vitest";
import { detectDestructiveCommand } from "../../../../lib/core/internal/guardian/history-gate.ts";

describe("detectDestructiveCommand", () => {
	it("detects each irrecoverable form", () => {
		for (const cmd of [
			"git push --force",
			"git reset --hard",
			"git clean -fd",
			"git branch -D feature",
			"git checkout -- .",
		]) {
			expect(detectDestructiveCommand(cmd)?.severity).toBe("irrecoverable");
		}
	});

	it("ignores a non-destructive command", () => {
		expect(detectDestructiveCommand("git status")).toBeNull();
		expect(detectDestructiveCommand("git commit -m x")).toBeNull();
	});

	it("grades --force-with-lease as risky and --force as irrecoverable", () => {
		// Ordering is load-bearing: the lease pattern must win over the
		// bare --force pattern, or a safer command is graded as the
		// harsher severity.
		expect(
			detectDestructiveCommand("git push --force-with-lease")?.severity,
		).toBe("risky");
		expect(detectDestructiveCommand("git push --force")?.severity).toBe(
			"irrecoverable",
		);
	});

	it("grades rebase as risky and reset --hard as irrecoverable", () => {
		expect(detectDestructiveCommand("git rebase -i HEAD~2")?.severity).toBe(
			"risky",
		);
		expect(detectDestructiveCommand("git reset --hard")?.severity).toBe(
			"irrecoverable",
		);
	});

	it("returns null for an undetected command", () => {
		expect(detectDestructiveCommand("git status")).toBeNull();
	});

	it("carries the description of the matched pattern", () => {
		expect(detectDestructiveCommand("git reset --hard")?.description).toBe(
			"Permanently discards all uncommitted changes.",
		);
	});

	it("carries the command back on the match", () => {
		expect(detectDestructiveCommand("git reset --hard")?.command).toBe(
			"git reset --hard",
		);
	});
});

describe("the safer form of an irrecoverable command", () => {
	it("names a remedy for every irrecoverable form", () => {
		for (const cmd of [
			"git push --force",
			"git reset --hard",
			"git clean -fd",
			"git branch -D feature",
			"git checkout -- .",
		]) {
			expect(detectDestructiveCommand(cmd)?.remedy, cmd).toMatch(/\S/);
		}
	});

	it("leaves a risky command without a remedy", () => {
		expect(detectDestructiveCommand("git rebase main")?.remedy).toBeUndefined();
	});

	it("rewrites a bare force push to a lease, keeping everything else", () => {
		expect(
			detectDestructiveCommand("git push --force origin feature")?.rewrite,
		).toBe("git push --force-with-lease origin feature");
		expect(
			detectDestructiveCommand("cd repo && git push -f origin feature")
				?.rewrite,
		).toBe("cd repo && git push --force-with-lease origin feature");
	});

	it("offers no rewrite where the safe form needs a judgement", () => {
		// Stashing first, or deleting a branch only when merged, changes what
		// the command means, so the agent has to choose it.
		for (const cmd of [
			"git reset --hard",
			"git clean -fd",
			"git branch -D feature",
			"git checkout -- .",
		]) {
			expect(detectDestructiveCommand(cmd)?.rewrite, cmd).toBeUndefined();
		}
	});

	it("does not mistake a commit message for a force push", () => {
		// Only the push's own flag is rewritten; the same text elsewhere in
		// the line is somebody's words.
		expect(detectDestructiveCommand("git push -f origin x-f")?.rewrite).toBe(
			"git push --force-with-lease origin x-f",
		);
	});
});

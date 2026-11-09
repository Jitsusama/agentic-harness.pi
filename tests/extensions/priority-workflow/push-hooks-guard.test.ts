/**
 * The priority workflow's guard on a push of World that skips dev's
 * pre-push hooks: refused in block mode, its default, and waved through
 * when the person turns it off.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { refuseSkippedPushHooks } from "../../../extensions/priority-workflow/index.ts";
import {
	restoreSessionModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import { GUARDS } from "../../../lib/internal/guardian/guards.ts";

type Verdict = { block?: boolean; reason?: string } | undefined;
type Handler = (event: unknown, ctx: { cwd: string }) => Promise<Verdict>;

function guard(): Handler {
	let handler: Handler | undefined;
	const pi = {
		on: (_name: string, fn: Handler) => {
			handler = fn;
		},
	} as unknown as Pick<ExtensionAPI, "on">;
	refuseSkippedPushHooks(pi);
	if (!handler) throw new Error("no tool_call handler registered");
	return handler;
}

const bash = (command: string) => ({
	type: "tool_call",
	toolName: "bash",
	toolCallId: "t1",
	input: { command },
});

const WORLD_TREE = { cwd: join(homedir(), "world", "trees", "a", "src") };

beforeEach(() => restoreSessionModes({}));

describe("a push of World past its pre-push hooks", () => {
	it("is refused, saying to push without the flag", async () => {
		const verdict = await guard()(
			bash("git push --no-verify origin HEAD:refs/heads/x 2>&1"),
			WORLD_TREE,
		);
		expect(verdict).toMatchObject({ block: true });
		expect(verdict?.reason).toContain("without --no-verify");
	});

	it("says to rebase an old branch first, and how a stacked one leaves out the stale-cutoff check alone", async () => {
		const reason =
			(await guard()(bash("git push --no-verify origin x"), WORLD_TREE))
				?.reason ?? "";

		expect(reason).toContain("rebase it onto main first");
		expect(reason).toContain("PI_PUSH_SKIPS_STALE_CUTOFF=1 git push");
		expect(reason.indexOf("rebase"), "rebasing is said first").toBeLessThan(
			reason.indexOf("PI_PUSH_SKIPS_STALE_CUTOFF"),
		);
	});

	it("lets a push that leaves out the stale-cutoff check alone go ahead", async () => {
		expect(
			await guard()(
				bash("PI_PUSH_SKIPS_STALE_CUTOFF=1 git push origin x"),
				WORLD_TREE,
			),
		).toBeUndefined();
	});

	it("goes ahead as a plain push, or anywhere but World", async () => {
		expect(
			await guard()(bash("git push origin HEAD:refs/heads/x"), WORLD_TREE),
		).toBeUndefined();
		expect(
			await guard()(bash("git push --no-verify origin x"), {
				cwd: join(homedir(), "src", "core.nix"),
			}),
		).toBeUndefined();
	});

	it("goes ahead when the person turns the guard off", async () => {
		setSessionMode(GUARDS.worldPushHooks.name, "off");
		expect(
			await guard()(bash("git push --no-verify origin x"), WORLD_TREE),
		).toBeUndefined();
	});
});

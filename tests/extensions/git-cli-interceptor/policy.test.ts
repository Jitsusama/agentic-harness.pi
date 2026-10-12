/**
 * The git-cli interceptor's two guards. The commit-shape redirects
 * block whatever the approvals do; the chain rule follows them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import gitCliInterceptor from "../../../extensions/git-cli-interceptor/index.ts";
import {
	restoreSessionModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import {
	declareGuards,
	GUARDS,
} from "../../../lib/internal/guardian/guards.ts";

type Handler = (event: unknown) => Promise<{ block?: boolean } | undefined>;

function interceptor(): Handler {
	let handler: Handler | undefined;
	const pi = {
		on: (_name: string, fn: Handler) => {
			handler = fn;
		},
	} as unknown as ExtensionAPI;
	gitCliInterceptor(pi);
	if (!handler) throw new Error("no tool_call handler registered");
	return handler;
}

const bash = (command: string) => ({
	type: "tool_call",
	toolName: "bash",
	toolCallId: "t1",
	input: { command },
});

const CHAIN = "git commit -m 'one' && gh pr create --title t --body b";

beforeEach(() => {
	declareGuards(GUARDS.commit, GUARDS.pr, GUARDS.issue);
	restoreSessionModes({});
});

describe("the git-cli interceptor under the policy", () => {
	it("refuses an amend while every approval reports", async () => {
		const verdict = await interceptor()(bash("git commit --amend -m 'x'"));
		expect(verdict?.block).toBe(true);
	});

	it("lets a chain through while every approval it protects reports", async () => {
		expect(await interceptor()(bash(CHAIN))).toBeUndefined();
	});

	it("refuses a chain once one of those approvals blocks", async () => {
		setSessionMode("pr", "block");
		const verdict = await interceptor()(bash(CHAIN));
		expect(verdict?.block).toBe(true);
	});

	it("lets an amend through when commit-shape is switched off", async () => {
		setSessionMode("commit-shape", "off");
		expect(
			await interceptor()(bash("git commit --amend -m 'x'")),
		).toBeUndefined();
	});
});

/**
 * The sleep guard as the interceptor applies it: a long sleep that
 * would hold the session is turned back, and one in a call already
 * sent to the background goes ahead. A pause that spins a core is
 * turned back wherever it runs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import shellHabitInterceptor from "../../../extensions/shell-habit-interceptor/index.ts";
import { restoreSessionModes } from "../../../lib/guardian/policy.ts";

type Verdict = { block?: boolean; reason?: string } | undefined;
type Handler = (event: unknown, ctx: { cwd: string }) => Promise<Verdict>;

function interceptor(): Handler {
	let handler: Handler | undefined;
	const pi = {
		on: (_name: string, fn: Handler) => {
			handler = fn;
		},
	} as unknown as ExtensionAPI;
	shellHabitInterceptor(pi);
	if (!handler) throw new Error("no tool_call handler registered");
	return handler;
}

const bash = (input: Record<string, unknown>) => ({
	type: "tool_call",
	toolName: "bash",
	toolCallId: "t1",
	input,
});

const ctx = { cwd: "/" };

beforeEach(() => {
	restoreSessionModes({});
});

describe("the sleep guard", () => {
	it("turns back a long sleep in a call that holds the session", async () => {
		const verdict = await interceptor()(
			bash({ command: "sleep 120; gh run list" }),
			ctx,
		);
		expect(verdict).toMatchObject({ block: true });
		expect(verdict?.reason).toContain("A sleep of 120 s holds this session");
	});

	it("lets a long sleep through in a call already in the background", async () => {
		const verdict = await interceptor()(
			bash({
				command:
					"for i in $(seq 1 60); do test -f done && break; sleep 45; done",
				background: true,
			}),
			ctx,
		);
		expect(verdict).toBeUndefined();
	});

	it("turns back a pause that spins, even in the background", async () => {
		const verdict = await interceptor()(
			bash({
				command:
					"until gh pr view 3 | grep -q MERGED; do read -t 120 < /dev/zero; done",
				background: true,
			}),
			ctx,
		);
		expect(verdict).toMatchObject({ block: true });
		expect(verdict?.reason).toContain("keeps a core busy");
	});

	it("still turns back a long sleep when background is only false", async () => {
		const verdict = await interceptor()(
			bash({ command: "sleep 1500; echo fired", background: false }),
			ctx,
		);
		expect(verdict).toMatchObject({ block: true });
	});
});

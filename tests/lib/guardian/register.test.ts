import { beforeEach, describe, expect, it } from "vitest";
import type {
	CommandGuardian,
	GuardianResult,
} from "../../../lib/guardian/index.ts";
import { registerGuardian } from "../../../lib/guardian/index.ts";
import {
	restoreSessionModes,
	setConfiguredModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import {
	type GuardReport,
	setGuardReportSink,
} from "../../../lib/guardian/report.ts";
import { clear, list } from "../../../lib/internal/guardian/registry.ts";

// Derive the pi and result types from registerGuardian's own signature
// so the test never imports the pi package directly (which does not
// resolve cleanly for test files under this tsconfig).
type Pi = Parameters<typeof registerGuardian>[0];
type BashEvent = { input: { command: string } };
type Ctx = { hasUI: boolean };
type Handler = (
	event: BashEvent,
	ctx: Ctx,
) => Promise<{ block?: boolean; reason?: string } | undefined>;

/** A fake pi that captures the tool_call handler registerGuardian installs. */
function captureHandler(): { pi: Pi; handler: () => Handler } {
	let captured: Handler | undefined;
	const pi = {
		on: (event: string, h: Handler) => {
			if (event === "tool_call") captured = h;
		},
	} as unknown as Pi;
	return {
		pi,
		handler: () => {
			if (!captured) throw new Error("no tool_call handler registered");
			return captured;
		},
	};
}

function bashEvent(command: string): BashEvent {
	return {
		type: "tool_call",
		toolCallId: "t1",
		toolName: "bash",
		input: { command },
	} as unknown as BashEvent;
}

function ctx(hasUI: boolean): Ctx {
	return { hasUI };
}

/** A guardian whose three steps are fixed per test. */
function guardian(
	over: Partial<CommandGuardian<string>>,
): CommandGuardian<string> {
	return {
		detect: () => true,
		parse: (c) => c,
		review: async (): Promise<GuardianResult> => undefined,
		...over,
	};
}

beforeEach(() => {
	clear();
	restoreSessionModes({});
	setConfiguredModes({});
	setGuardReportSink(undefined);
});

const declared = {
	name: "t-reg",
	class: "approval" as const,
	description: "",
	defaultMode: "redirect" as const,
};

describe("registerGuardian under the policy", () => {
	it("still reviews a guard that is off, telling it so, so it can report", async () => {
		// Off was silent once, so a person who switched a guard off never
		// saw what it would have said. Now it only steps out of the way.
		const { pi, handler } = captureHandler();
		const modes: unknown[] = [];
		registerGuardian(
			pi,
			guardian({
				review: async (_p, _c, mode) => {
					modes.push(mode);
					return undefined;
				},
			}),
			{ declaration: declared },
		);
		setSessionMode("t-reg", "off");

		const result = await handler()(bashEvent("git commit -m x"), ctx(true));

		expect(result).toBeUndefined();
		expect(modes).toEqual(["off"]);
	});

	it("skips a bypassed guard without detecting", async () => {
		const { pi, handler } = captureHandler();
		let detected = false;
		registerGuardian(
			pi,
			guardian({
				detect: () => {
					detected = true;
					return true;
				},
			}),
			{ declaration: declared, bypass: () => true },
		);

		const result = await handler()(bashEvent("git commit -m x"), ctx(true));

		expect(result).toBeUndefined();
		expect(detected).toBe(false);
	});

	it("hands review the guard's mode", async () => {
		const { pi, handler } = captureHandler();
		const modes: unknown[] = [];
		registerGuardian(
			pi,
			guardian({
				review: async (_p, _c, mode) => {
					modes.push(mode);
					return undefined;
				},
			}),
			{ declaration: declared },
		);

		await handler()(bashEvent("git commit -m x"), ctx(true));
		setSessionMode("t-reg", "block");
		await handler()(bashEvent("git commit -m x"), ctx(true));

		expect(modes).toEqual(["redirect", "block"]);
	});

	it("lets an unreadable shape through with a report outside block", async () => {
		const { pi, handler } = captureHandler();
		const seen: GuardReport[] = [];
		setGuardReportSink((r) => seen.push(r));
		registerGuardian(pi, guardian({}), { declaration: declared });

		const result = await handler()(
			bashEvent("x=$(git commit -m y)"),
			ctx(true),
		);

		expect(result).toBeUndefined();
		expect(seen.map((r) => [r.guard, r.kind])).toEqual([["t-reg", "waved"]]);
	});

	it("refuses an unreadable shape when blocking", async () => {
		const { pi, handler } = captureHandler();
		registerGuardian(pi, guardian({}), { declaration: declared });
		setConfiguredModes({ approval: "block" });

		const result = await handler()(
			bashEvent("x=$(git commit -m y)"),
			ctx(true),
		);

		expect(result?.block).toBe(true);
	});
});

describe("registerGuardian pipeline", () => {
	it("applies a rewrite by mutating the command and allowing", async () => {
		const { pi, handler } = captureHandler();
		registerGuardian(
			pi,
			guardian({ review: async () => ({ rewrite: "git commit -m safe" }) }),
		);

		const event = bashEvent("git commit -m raw");
		const result = await handler()(event, ctx(true));

		expect(result).toBeUndefined();
		expect(event.input.command).toBe("git commit -m safe");
	});

	it("returns a block verbatim and never reaches parse on unsupported shape", async () => {
		const { pi, handler } = captureHandler();
		let parsed = false;
		registerGuardian(
			pi,
			guardian({
				parse: () => {
					parsed = true;
					return "x";
				},
			}),
		);

		// Command substitution is a shape blockIfUnsupported rejects, so
		// the fail-closed block fires before the guardian parses.
		const result = await handler()(
			bashEvent("x=$(git commit -m y)"),
			ctx(true),
		);

		expect(result?.block).toBe(true);
		expect(parsed).toBe(false);
	});

	it("skips without a UI unless enforceWithoutUI is set", async () => {
		const { pi, handler } = captureHandler();
		let reviewed = false;
		registerGuardian(
			pi,
			guardian({
				review: async () => {
					reviewed = true;
					return undefined;
				},
			}),
			{ name: "commit" },
		);

		const result = await handler()(bashEvent("git commit -m x"), ctx(false));

		expect(result).toBeUndefined();
		expect(reviewed).toBe(false);
		expect(list()[0].lastOutcome).toEqual({ kind: "skipped", why: "no-ui" });
	});

	it("skips when the bypass returns true, before detect", async () => {
		const { pi, handler } = captureHandler();
		let detected = false;
		registerGuardian(
			pi,
			guardian({
				detect: () => {
					detected = true;
					return true;
				},
			}),
			{ bypass: () => true },
		);

		const result = await handler()(bashEvent("git commit -m x"), ctx(true));

		expect(result).toBeUndefined();
		expect(detected).toBe(false);
	});

	it("passes the command through when the guardian allows", async () => {
		const { pi, handler } = captureHandler();
		registerGuardian(pi, guardian({ review: async () => undefined }));

		const event = bashEvent("git commit -m x");
		const result = await handler()(event, ctx(true));

		expect(result).toBeUndefined();
		expect(event.input.command).toBe("git commit -m x");
	});
});

/** How the host builds pi's screen and reads its private parts. */
import { describe, expect, it } from "vitest";
import {
	atRest,
	type HostedMode,
	type HostedModeOptions,
	hostedModeOf,
	stopScreen,
	working,
} from "../../../host/screen/hosted-mode.ts";
import { ViewerTerminal } from "../../../lib/core/viewer/terminal.ts";

/** A stand-in for pi's InteractiveMode class with the lifecycle patch. */
class PatchedMode implements HostedMode {
	static readonly hostedLifecycleVersion = 1;
	static readonly hostedQuit = true;
	readonly runtime: unknown;
	readonly options: HostedModeOptions;

	constructor(runtime: unknown, options: HostedModeOptions) {
		this.runtime = runtime;
		this.options = options;
	}

	init(): Promise<void> {
		return Promise.resolve();
	}

	run(): Promise<void> {
		return Promise.resolve();
	}
}

/** A stand-in for pi's screen with no shutdown, and nothing else of pi's. */
const bare: HostedMode = {
	init: () => Promise.resolve(),
	run: () => Promise.resolve(),
};

/** A conversation neither answering, compacting nor running a command. */
const idle = {
	isStreaming: false,
	isCompacting: false,
	isBashRunning: false,
	pendingMessageCount: 0,
};

describe("pi's hosted screen class", () => {
	it("builds pi's hosted screen over the conversation's runtime", () => {
		const runtime = {};
		const create = hostedModeOf(PatchedMode);
		const hosted = {
			onExit: async () => undefined,
			editText: async () => ({ status: "failed", message: "none" }) as const,
			suspend: () => false,
			quit: async () => true,
		};
		const terminal = new ViewerTerminal("a", () => {});
		const mode = create(runtime, {
			terminal,
			hosted,
			startupDiagnostics: [],
		});
		expect(mode).toBeInstanceOf(PatchedMode);
		expect(mode instanceof PatchedMode && mode.runtime).toBe(runtime);
		expect(
			mode instanceof PatchedMode && mode.options.terminal,
			"the screen draws on the conversation's terminal",
		).toBe(terminal);
	});

	it("refuses a pi whose screen would own the host's process", () => {
		class Ordinary {}
		expect(() => hostedModeOf(Ordinary)).toThrow(
			"pi's InteractiveMode lacks the hosted lifecycle (pi-host-interactive-lifecycle.patch)",
		);
		expect(() => hostedModeOf(undefined)).toThrow("lacks the hosted lifecycle");
		const Later = Object.assign(() => undefined, {
			hostedLifecycleVersion: 2,
			hostedQuit: true,
		});
		expect(() => hostedModeOf(Later), "another lifecycle version").toThrow(
			"lacks the hosted lifecycle",
		);
	});

	it("refuses a pi whose screen would quit without asking the host", () => {
		// A class with the lifecycle's version and no hosted quit.
		const Unasking = Object.assign(() => undefined, {
			hostedLifecycleVersion: 1,
		});
		expect(() => hostedModeOf(Unasking)).toThrow(
			"pi's InteractiveMode lacks the hosted quit, which asks the host before a screen quits (pi-host-interactive-lifecycle.patch)",
		);
		const Loose = Object.assign(() => undefined, {
			hostedLifecycleVersion: 1,
			hostedQuit: "yes",
		});
		expect(() => hostedModeOf(Loose), "a quit that isn't true").toThrow(
			"lacks the hosted quit",
		);
	});
});

describe("pi's private parts, read without trusting them", () => {
	it("counts a conversation working unless it says it is idle", () => {
		expect(working({ session: idle }), "idle").toBe(false);
		expect(
			working({ session: { ...idle, isCompacting: true } }),
			"compacting",
		).toBe(true);
		expect(
			working({ session: { isStreaming: false } }),
			"flags it can't read",
		).toBe(true);
		expect(working({}), "no session").toBe(true);
	});

	it("counts a compacting conversation as not at rest", () => {
		const editor = { getText: () => "" };
		const mode = {
			...bare,
			ui: { getFocusedComponent: () => editor, hasOverlay: () => false },
			editor,
		};
		expect(atRest(mode, { session: idle }), "at rest").toBe(true);
		expect(
			atRest(mode, { session: { ...idle, isCompacting: true } }),
			"compacting",
		).toBe(false);
	});

	it("refuses to stop a screen that has no shutdown", async () => {
		await expect(stopScreen(bare)).rejects.toThrow(
			"Conversation closed, but its screen has no way to stop",
		);
	});
});

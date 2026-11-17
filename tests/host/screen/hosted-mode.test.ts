/** The host takes only a pi whose screen has the hosted lifecycle and quit. */
import { describe, expect, it } from "vitest";
import {
	type HostedMode,
	type HostedModeOptions,
	hostedModeOf,
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

describe("the host's pi screen", () => {
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
	});

	it("refuses a pi whose screen would own the host's process", () => {
		class Ordinary {}
		expect(() => hostedModeOf(Ordinary)).toThrow(
			"pi's InteractiveMode lacks the hosted lifecycle (pi-host-interactive-lifecycle.patch)",
		);
		expect(() => hostedModeOf(undefined)).toThrow("lacks the hosted lifecycle");
	});

	it("refuses a pi whose screen would quit without asking the host", () => {
		// A class with the lifecycle's version and no hosted quit.
		const Unasking = Object.assign(() => undefined, {
			hostedLifecycleVersion: 1,
		});
		expect(() => hostedModeOf(Unasking)).toThrow(
			"pi's InteractiveMode lacks the hosted quit, which asks the host before a screen quits (pi-host-interactive-lifecycle.patch)",
		);
	});
});

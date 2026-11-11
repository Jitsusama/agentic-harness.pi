/** A hosted screen's quit closes its conversation only once the viewer that typed it says so. */
import { describe, expect, it, vi } from "vitest";
import {
	type HostedMode,
	type HostedModeOptions,
	type HostedView,
	hostedModeOf,
	hostScreens,
} from "../../../host/screen/screens.ts";
import { LEFT_RUNNING } from "../../../lib/core/viewer/terminal.ts";

/**
 * pi's hosted screen as today's runtime has it: Ctrl+D goes straight to its
 * shutdown, which stops the screen and tells the host.
 */
class Unasking implements HostedMode {
	static readonly hostedLifecycleVersion = 1;
	readonly ui = { requestRender: vi.fn() };
	readonly session: { isStreaming: boolean };
	readonly options: HostedModeOptions;
	readonly stopped = vi.fn();
	private finish: (() => void) | undefined;

	constructor(runtime: unknown, options: HostedModeOptions) {
		this.options = options;
		this.session = { isStreaming: false };
		void runtime;
	}

	async init(): Promise<void> {
		this.options.terminal.start(
			(data) => {
				if (data === "\x04") void this.quitKey();
			},
			() => {},
		);
	}

	run(): Promise<void> {
		return new Promise((resolve) => {
			this.finish = resolve;
		});
	}

	protected quitKey(): Promise<void> {
		return this.shutdown();
	}

	async shutdown(): Promise<void> {
		this.stopped();
		this.options.terminal.stop();
		await this.options.hosted.onExit(0);
		this.finish?.();
	}
}

/** The same screen on a runtime whose hosted quit asks its host first. */
class Asking extends Unasking {
	static readonly hostedQuit = true;

	protected override async quitKey(): Promise<void> {
		if (await this.options.hosted.quit()) await this.shutdown();
	}
}

function sink() {
	return {
		write: vi.fn<(data: string) => void>(),
		disconnect: vi.fn<(reason: string) => void>(),
		edit: vi.fn(),
		suspend: vi.fn(),
	};
}

function attach(sessionId: string) {
	return {
		v: 1,
		id: "r1",
		op: "attach",
		sessionId,
		rows: 24,
		columns: 200,
	} as const;
}

function host(pi: unknown) {
	const create = hostedModeOf(pi);
	const made: HostedMode[] = [];
	const screens = hostScreens({
		create: (runtime, options) => {
			const mode = create(runtime, options);
			made.push(mode);
			return mode;
		},
		report: vi.fn(),
	});
	const closes: string[] = [];
	function view(sessionId: string): HostedView {
		return {
			sessionId,
			runtime: { session: { isStreaming: false } },
			close: async (why) => {
				closes.push(why);
				await screens.screens.closed(sessionId);
			},
		};
	}
	return { screens, closes, view, made };
}

describe.each([
	["today's runtime, its shutdown wrapped", Unasking],
	["a runtime that asks its host", Asking],
])("a hosted screen's quit on %s", (_, pi) => {
	it("closes for everyone once the viewer that typed it says y, naming that viewer", async () => {
		const { screens, closes, view } = host(pi);
		await screens.screens.opened(view("a"));
		const typing = sink();
		const other = sink();
		const one = screens.viewer.attach(attach("a"), typing);
		screens.viewer.attach(attach("a"), other);

		one.input("\x04");
		await Promise.resolve();
		expect(closes, "nothing closes before it is answered").toEqual([]);
		one.input("y");

		await vi.waitFor(() => expect(closes).toHaveLength(1));
		expect(closes[0], "the close names who asked").toMatch(
			/^quit, asked by viewer 1, joined /,
		);
		expect(other.disconnect, "everyone else is let go").toHaveBeenCalledWith(
			"Conversation closed",
		);
	});

	it("closes at once for a lone viewer, as plain pi's quit does, naming that viewer", async () => {
		const { screens, closes, view } = host(pi);
		await screens.screens.opened(view("a"));
		const alone = sink();
		const one = screens.viewer.attach(attach("a"), alone);

		one.input("\x04");

		await vi.waitFor(() => expect(closes).toHaveLength(1));
		expect(closes[0], "the close names who asked").toMatch(
			/^quit, asked by viewer 1, joined /,
		);
		expect(
			alone.disconnect,
			"its window is told it closed",
		).toHaveBeenCalledWith("Conversation closed");
	});

	it("lets only that viewer go and keeps the screen when it says anything else", async () => {
		const { screens, closes, view } = host(pi);
		await screens.screens.opened(view("a"));
		const typing = sink();
		const other = sink();
		const one = screens.viewer.attach(attach("a"), typing);
		screens.viewer.attach(attach("a"), other);

		one.input("\x04");
		one.input("n");
		await Promise.resolve();

		expect(typing.disconnect, "that viewer goes").toHaveBeenCalledWith(
			LEFT_RUNNING,
		);
		expect(closes, "the conversation stays").toEqual([]);
		expect(screens.ids(), "its screen runs on").toEqual(["a"]);
		expect(other.disconnect, "the other stays").not.toHaveBeenCalled();
		screens.viewer.attach(attach("a"), sink());
	});

	it("stops the screen at once when the conversation closes elsewhere", async () => {
		const { screens, closes, view } = host(pi);
		await screens.screens.opened(view("a"));
		const watching = sink();
		screens.viewer.attach(attach("a"), watching);

		await screens.screens.closed("a");

		expect(closes, "a close from elsewhere isn't closed again").toEqual([]);
		expect(watching.disconnect).toHaveBeenCalledWith("Conversation closed");
	});
});

describe("the wrap on today's runtime", () => {
	it("wraps only a runtime that doesn't ask its host itself", async () => {
		const today = host(Unasking);
		const hooked = host(Asking);
		await today.screens.screens.opened(today.view("a"));
		await hooked.screens.screens.opened(hooked.view("a"));

		expect(
			Object.hasOwn(today.made[0] ?? {}, "shutdown"),
			"today's screen asks before its own quit",
		).toBe(true);
		expect(
			Object.hasOwn(hooked.made[0] ?? {}, "shutdown"),
			"a screen that asks itself keeps pi's own quit",
		).toBe(false);
	});
});

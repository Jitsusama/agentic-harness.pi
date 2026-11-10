/** Persistent screens: one per conversation, quitting closes only its own, viewers come and go. */
import { describe, expect, it, vi } from "vitest";
import type { EngineScreens } from "../../../host/engine/index.ts";
import {
	type HostedMode,
	type HostedModeOptions,
	type HostedView,
	hostedModeOf,
	hostScreens,
} from "../../../host/screen/screens.ts";
import type { StartupAsker } from "../../../host/screen/startup-ask.ts";
import { ambientSession } from "../../../lib/core/session/index.ts";
import { ViewerTerminal } from "../../../lib/core/viewer/terminal.ts";

/** A stand-in for pi's hosted InteractiveMode: it starts, then runs until it quits. */
class FakeMode implements HostedMode {
	static readonly hostedLifecycleVersion = 1;
	readonly ui = { requestRender: vi.fn() };
	/** Set to hold startup until a test lets it finish, or fail it. */
	static startup: Promise<void> = Promise.resolve();
	startedIn: string | undefined;
	ranIn: string | undefined;
	private finish: (() => void) | undefined;
	private fail: ((error: unknown) => void) | undefined;

	readonly runtime: unknown;
	readonly options: HostedModeOptions;

	constructor(runtime: unknown, options: HostedModeOptions) {
		this.runtime = runtime;
		this.options = options;
	}

	init(): Promise<void> {
		this.startedIn = ambientSession();
		return FakeMode.startup;
	}

	run(): Promise<void> {
		this.ranIn = ambientSession();
		return new Promise((resolve, reject) => {
			this.finish = resolve;
			this.fail = reject;
		});
	}

	/** What pi's quit does in a hosted screen: stop, tell the host, end run. */
	readonly shutdown = vi.fn(async () => {
		await this.options.hosted.onExit(0);
		this.finish?.();
	});

	crash(error: unknown): void {
		this.fail?.(error);
	}
}

/** A stand-in for pi's startup selector: each question waits until the test answers it. */
function asker() {
	const asked: {
		readonly terminal: ViewerTerminal;
		readonly title: string;
		readonly labels: readonly string[];
		readonly pick: (label: string | undefined) => void;
		readonly repaint: ReturnType<typeof vi.fn>;
		readonly cancel: ReturnType<typeof vi.fn>;
	}[] = [];
	const ask: StartupAsker = (terminal, title, labels) => {
		let pick: (label: string | undefined) => void = () => undefined;
		const answer = new Promise<string | undefined>((done) => {
			pick = done;
		});
		const repaint = vi.fn();
		const cancel = vi.fn(() => pick(undefined));
		asked.push({ terminal, title, labels, pick, repaint, cancel });
		return { answer, repaint, cancel };
	};
	return { ask, asked };
}

function host(ask?: StartupAsker) {
	const modes = new Map<unknown, FakeMode>();
	const report = vi.fn();
	const screens = hostScreens({
		create: (runtime, options) => {
			const mode = new FakeMode(runtime, options);
			modes.set(runtime, mode);
			return mode;
		},
		report,
		...(ask ? { ask } : {}),
	});
	const closes: [string, string][] = [];
	function view(
		sessionId: string,
		runtime: unknown = { sessionId },
	): HostedView {
		return {
			sessionId,
			runtime,
			close: async (why) => {
				closes.push([sessionId, why]);
				await screens.screens.closed(sessionId);
			},
		};
	}
	function mode(runtime: unknown): FakeMode {
		const found = modes.get(runtime);
		if (!found) throw new Error("no screen was built over that runtime");
		return found;
	}
	return { ...screens, report, closes, view, mode };
}

function sink() {
	return {
		write: vi.fn(),
		disconnect: vi.fn(),
		edit: vi.fn(),
		suspend: vi.fn(),
	};
}

function attach(sessionId: string, rows = 40, columns = 120) {
	return { v: 1, id: "r1", op: "attach", sessionId, rows, columns } as const;
}

describe("hosted screens", () => {
	it("runs a screen in its conversation before anyone watches, and viewers join it", async () => {
		const screens = host();
		const a = screens.view("a");
		await screens.screens.opened(a);
		const mode = screens.mode(a.runtime);
		expect(mode.startedIn, "the screen starts under its own session").toBe("a");
		expect(mode.ranIn, "the screen runs under its own session").toBe("a");
		const one = sink();
		screens.viewer.attach(attach("a"), one);
		expect(mode.ui.requestRender).toHaveBeenCalledWith(true);
		mode.options.terminal.write("hello");
		expect(one.write).toHaveBeenCalledWith("hello");
	});

	it("hands the screen what pi said as the conversation started, as pi's CLI does", async () => {
		const screens = host();
		const failed = {
			type: "error",
			message: 'Failed to load extension "/x/index.ts": boom',
		} as const;
		const said = screens.view("a", {
			diagnostics: [failed, { type: "loud" }, "noise"],
		});
		const quiet = screens.view("b");
		await screens.screens.opened(said);
		await screens.screens.opened(quiet);
		expect(screens.mode(said.runtime).options.startupDiagnostics).toEqual([
			failed,
		]);
		expect(screens.mode(quiet.runtime).options.startupDiagnostics).toEqual([]);
	});

	it("sends a viewer that joins the screen's images, where pi's renderer can", async () => {
		const screens = host();
		const a = screens.view("a");
		await screens.screens.opened(a);
		const mode = screens.mode(a.runtime);
		const repaintForNewTerminal = vi.fn();
		Object.assign(mode.ui, { repaintForNewTerminal });

		screens.viewer.attach(attach("a"), sink());

		expect(repaintForNewTerminal).toHaveBeenCalledOnce();
		expect(
			mode.ui.requestRender,
			"a forced render alone would place images the viewer never got",
		).not.toHaveBeenCalled();
	});

	it("hands pi's Ctrl+G and Ctrl+Z to the viewer that pressed them", async () => {
		const screens = host();
		const a = screens.view("a");
		await screens.screens.opened(a);
		const { options } = screens.mode(a.runtime);
		options.terminal.start(
			() => {},
			() => {},
		);
		const pressing = sink();
		const attached = screens.viewer.attach(
			{ ...attach("a"), features: ["edit", "suspend"] },
			pressing,
		);
		attached.input("g");

		const edit = options.hosted.editText("draft");
		expect(pressing.edit).toHaveBeenCalledWith("1", "draft");
		attached.edited?.("1", "edited\n");
		await expect(edit).resolves.toEqual({
			status: "complete",
			content: "edited",
		});
		attached.input("z");

		expect(
			options.hosted.suspend(),
			"a viewer that can suspend takes pi's Ctrl+Z",
		).toBe(true);
		expect(pressing.suspend).toHaveBeenCalledOnce();
	});

	it("has started its screen before the engine sends the first words", async () => {
		const screens = host();
		let started: () => void = () => undefined;
		FakeMode.startup = new Promise((done) => {
			started = done;
		});
		try {
			let opened = false;
			const opening = Promise.resolve(
				screens.screens.opened(screens.view("a")),
			).then(() => {
				opened = true;
			});
			await Promise.resolve();
			expect(opened, "opened waits for the screen's startup").toBe(false);
			started();
			await opening;
			expect(opened, "opened settles once the screen has started").toBe(true);
		} finally {
			FakeMode.startup = Promise.resolve();
		}
	});

	it("a screen that fails to start fails the open and keeps no screen", async () => {
		const screens = host();
		const failure = new Error("no theme");
		FakeMode.startup = Promise.reject(failure);
		try {
			await expect(
				Promise.resolve(screens.screens.opened(screens.view("a"))),
			).rejects.toBe(failure);
			expect(screens.ids()).toEqual([]);
			expect(screens.closes, "the engine fails the open itself").toEqual([]);
		} finally {
			FakeMode.startup = Promise.resolve();
		}
	});

	it("quitting one screen closes only its conversation and lets its viewers go", async () => {
		const screens = host();
		const a = screens.view("a");
		const b = screens.view("b");
		await screens.screens.opened(a);
		await screens.screens.opened(b);
		const watching = sink();
		const sibling = sink();
		screens.viewer.attach(attach("a"), watching);
		screens.viewer.attach(attach("b"), sibling);
		await screens.mode(a.runtime).shutdown();
		expect(screens.closes).toEqual([["a", "quit"]]);
		expect(screens.ids()).toEqual(["b"]);
		expect(watching.disconnect).toHaveBeenCalledWith("Conversation closed");
		expect(sibling.disconnect).not.toHaveBeenCalled();
		expect(screens.mode(a.runtime).shutdown).toHaveBeenCalledTimes(1);
	});

	it("a conversation closed from elsewhere stops its screen without closing it again", async () => {
		const screens = host();
		const a = screens.view("a");
		await screens.screens.opened(a);
		await screens.screens.closed("a");
		expect(screens.mode(a.runtime).shutdown).toHaveBeenCalledTimes(1);
		expect(screens.closes).toEqual([]);
		expect(() => screens.viewer.attach(attach("a"), sink())).toThrow(
			"Conversation has no screen: a",
		);
	});

	it("a screen that fails closes its conversation and says why", async () => {
		const screens = host();
		const a = screens.view("a");
		await screens.screens.opened(a);
		const failure = new Error("renderer broke");
		screens.mode(a.runtime).crash(failure);
		await vi.waitFor(() => expect(screens.closes).toHaveLength(1));
		expect(screens.closes).toEqual([["a", "screen ended with 1"]]);
		expect(screens.report).toHaveBeenCalledWith(failure);
	});

	it("follows a rebound conversation to its new id, keeping its viewers", async () => {
		const screens = host();
		const runtime = { shared: true };
		await screens.screens.opened(screens.view("a", runtime));
		const watching = sink();
		screens.viewer.attach(attach("a"), watching);
		await screens.screens.rebound(screens.view("c", runtime), "a");
		expect(screens.ids()).toEqual(["c"]);
		expect(screens.mode(runtime).options.terminal.sessionId).toBe("c");
		expect(() => screens.viewer.attach(attach("a"), sink())).toThrow(
			"Conversation has no screen: a",
		);
		screens.viewer.attach(attach("c"), sink());
		expect(watching.disconnect).not.toHaveBeenCalled();
		await screens.mode(runtime).shutdown();
		expect(screens.closes).toEqual([["c", "quit"]]);
	});

	it("asks whether to trust a folder on the conversation's terminal, which viewers join and its screen keeps", async () => {
		const { ask, asked } = asker();
		const screens = host(ask);
		const answer = screens.screens.askProjectTrust?.(
			"a",
			"/project",
			"Trust project folder?",
			["Trust", "Don't trust"],
		);
		const [question] = asked;
		expect(question?.title).toBe("Trust project folder?");
		expect(question?.labels).toEqual(["Trust", "Don't trust"]);
		const watching = sink();
		screens.viewer.attach(attach("a"), watching);
		expect(
			question?.repaint,
			"a viewer joining sees the question",
		).toHaveBeenCalled();

		question?.pick("Trust");
		await expect(answer).resolves.toBe("Trust");
		const a = screens.view("a");
		await screens.screens.opened(a);

		const mode = screens.mode(a.runtime);
		expect(mode.options.terminal).toBe(question?.terminal);
		expect(
			watching.disconnect,
			"its viewer stays for the screen",
		).not.toHaveBeenCalled();
		screens.viewer.attach(attach("a"), sink());
		expect(mode.ui.requestRender).toHaveBeenCalledWith(true);
	});

	it("a conversation closed while it asks settles the question unanswered and lets its viewers go", async () => {
		const { ask, asked } = asker();
		const screens = host(ask);
		const answer = screens.screens.askProjectTrust?.("a", "/p", "Trust?", [
			"Trust",
		]);
		const watching = sink();
		screens.viewer.attach(attach("a"), watching);

		await screens.screens.closed("a");

		await expect(answer).resolves.toBeUndefined();
		expect(asked[0]?.cancel).toHaveBeenCalledOnce();
		expect(watching.disconnect).toHaveBeenCalledWith("Conversation closed");
		expect(() => screens.viewer.attach(attach("a"), sink())).toThrow(
			"Conversation has no screen: a",
		);
	});

	it("asks nothing without an asker, and one question at a time on the same terminal", async () => {
		expect(host().screens.askProjectTrust).toBeUndefined();
		const { ask, asked } = asker();
		const screens = host(ask);
		const first = screens.screens.askProjectTrust?.("a", "/p", "Trust?", [
			"Trust",
		]);
		await expect(
			screens.screens.askProjectTrust?.("a", "/p", "Sure?", ["Yes", "No"]),
		).rejects.toThrow("Conversation is already asking: a");

		asked[0]?.pick("Trust");
		await first;
		const second = screens.screens.askProjectTrust?.("a", "/p", "Sure?", [
			"Yes",
			"No",
		]);
		expect(asked[1]?.terminal, "the next question shares the terminal").toBe(
			asked[0]?.terminal,
		);
		asked[1]?.pick("Yes");
		await expect(second).resolves.toBe("Yes");

		await screens.screens.opened(screens.view("a"));
		await expect(
			screens.screens.askProjectTrust?.("a", "/p", "Trust?", ["Trust"]),
		).rejects.toThrow("Conversation already has a screen: a");
	});

	it("refuses a rebind onto another runtime and a second screen for one id", async () => {
		const screens = host();
		await screens.screens.opened(screens.view("a"));
		expect(() => screens.screens.rebound(screens.view("c"), "a")).toThrow(
			"Conversation a was rebound onto another runtime",
		);
		await expect(
			Promise.resolve(screens.screens.opened(screens.view("a"))),
		).rejects.toThrow("Conversation already has a screen: a");
		expect(screens.ids()).toEqual(["a"]);
	});
});

describe("the host's pi screen", () => {
	it("is what the engine takes as its screens", () => {
		// Typechecked: the engine's own contract, so the two can't drift apart
		// before the host wires one into the other.
		const screens: EngineScreens = host().screens;
		expect(screens.opened, "the screens answer the engine's opened").toBeTypeOf(
			"function",
		);
	});

	it("builds pi's hosted screen over the conversation's runtime", () => {
		const runtime = {};
		const create = hostedModeOf(FakeMode);
		const hosted = {
			onExit: async () => undefined,
			editText: async () => ({ status: "failed", message: "none" }) as const,
			suspend: () => false,
		};
		const terminal = new ViewerTerminal("a", () => {});
		const mode = create(runtime, {
			terminal,
			hosted,
			startupDiagnostics: [],
		});
		expect(mode).toBeInstanceOf(FakeMode);
		expect(mode instanceof FakeMode && mode.runtime).toBe(runtime);
	});

	it("refuses a pi whose screen would own the host's process", () => {
		class Ordinary {}
		expect(() => hostedModeOf(Ordinary)).toThrow(
			"pi's InteractiveMode lacks the hosted lifecycle (pi-host-interactive-lifecycle.patch)",
		);
		expect(() => hostedModeOf(undefined)).toThrow("lacks the hosted lifecycle");
	});
});

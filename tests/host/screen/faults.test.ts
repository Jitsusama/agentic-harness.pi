/**
 * A throw nothing caught in one hosted screen: the first takes its
 * extensions' screen down, a second closes only its conversation, and
 * the host's other conversations carry on.
 */
import { describe, expect, it, vi } from "vitest";
import {
	type HostedMode,
	type HostedModeOptions,
	type HostedView,
	hostScreens,
} from "../../../host/screen/screens.ts";
import { ambientSession } from "../../../lib/core/session/index.ts";

/** pi's hosted screen as far as a fault reaches it. */
class FaultyMode implements HostedMode {
	readonly ui = { requestRender: vi.fn() };
	readonly errors: string[] = [];
	/** The conversation each reset of the extensions' screen ran in. */
	readonly resets: (string | undefined)[] = [];
	readonly options: HostedModeOptions;

	constructor(options: HostedModeOptions) {
		this.options = options;
	}
	init(): Promise<void> {
		return Promise.resolve();
	}
	run(): Promise<void> {
		return new Promise(() => {});
	}
	showError(message: string): void {
		this.errors.push(message);
	}
	readonly shutdown = vi.fn(async () => {});
	/** What pi's /reload does to the screen before loading extensions again. */
	resetExtensionUI(): void {
		this.resets.push(ambientSession());
	}
	/** A frame drawn by pi's renderer, through the terminal's scope, that throws. */
	drawThrowing(message: string): void {
		this.options.terminal.renderScope(() => {
			throw new Error(message);
		});
	}
}

/** pi's screen before it could take down what extensions put on it. */
class BareMode extends FaultyMode {
	override resetExtensionUI = undefined as never;
}

function host(make = (options: HostedModeOptions) => new FaultyMode(options)) {
	const modes = new Map<string, FaultyMode>();
	const report = vi.fn();
	const closes: [string, string][] = [];
	let opening = "";
	const screens = hostScreens({
		create: (_runtime, options) => {
			const mode = make(options);
			modes.set(opening, mode);
			return mode;
		},
		report,
	});
	async function open(sessionId: string): Promise<FaultyMode> {
		opening = sessionId;
		const view: HostedView = {
			sessionId,
			runtime: { sessionId },
			close: async (why) => {
				closes.push([sessionId, why]);
				await screens.screens.closed(sessionId);
			},
		};
		await screens.screens.opened(view);
		const mode = modes.get(sessionId);
		if (!mode) throw new Error(`no screen for ${sessionId}`);
		// A screen draws only for someone watching; the join's own repaint
		// is forgotten, so a test sees only what a fault asked for.
		mode.options.terminal.attach({
			rows: 40,
			columns: 120,
			write: () => {},
			disconnect: () => {},
		});
		mode.ui.requestRender.mockClear();
		return mode;
	}
	return { ...screens, report, closes, open };
}

describe("one hosted screen that throws", () => {
	it("takes its extensions' screen down the first time, says so, and draws again", async () => {
		const screens = host();
		const broken = await screens.open("a");
		const other = await screens.open("b");

		broken.drawThrowing("This extension ctx is stale");

		expect(broken.resets).toEqual(["a"]);
		expect(broken.errors).toEqual([
			expect.stringContaining(
				"This extension ctx is stale. /reload puts them back.",
			),
		]);
		expect(broken.ui.requestRender).toHaveBeenCalledWith(true);
		expect(screens.report).toHaveBeenCalledOnce();
		expect(screens.closes).toEqual([]);
		expect(other.resets).toEqual([]);
		expect(screens.ids()).toEqual(["a", "b"]);
	});

	it("closes only its own conversation when it throws again", async () => {
		const screens = host();
		const broken = await screens.open("a");
		await screens.open("b");

		broken.drawThrowing("stale");
		broken.drawThrowing("stale");
		broken.drawThrowing("stale");
		await vi.waitFor(() => expect(screens.ids()).toEqual(["b"]));

		expect(screens.closes).toEqual([["a", "its screen kept throwing"]]);
		expect(screens.report, "two reports, then quiet").toHaveBeenCalledTimes(2);
	});

	it("closes at once where pi can't take its extensions' screen down", async () => {
		const screens = host((options) => new BareMode(options));
		const broken = await screens.open("a");

		broken.drawThrowing("stale");
		await vi.waitFor(() => expect(screens.ids()).toEqual([]));

		expect(screens.closes).toEqual([["a", "its screen kept throwing"]]);
	});
});

describe("a throw the host's process caught", () => {
	it("is contained in the conversation it names, if that has a screen", async () => {
		const screens = host();
		const mode = await screens.open("a");

		expect(
			screens.faulted("a", new Error("a timer broke")),
			"a live screen contains its conversation's throw",
		).toBe(true);
		expect(
			screens.faulted("gone", new Error("elsewhere")),
			"no screen contains an unknown conversation's throw",
		).toBe(false);

		expect(mode.resets).toEqual(["a"]);
	});

	it("is still its conversation's once the screen has closed, and touches it no more", async () => {
		const screens = host();
		const mode = await screens.open("a");
		await screens.screens.closed("a");

		expect(
			screens.faulted("a", new Error("a leftover timer")),
			"a closed conversation's throw is still contained",
		).toBe(true);
		mode.drawThrowing("a leftover frame");
		screens.faulted("a", new Error("and another"));

		expect(mode.resets, "a closed screen is never reset").toEqual([]);
		expect(screens.closes).toEqual([]);
		expect(screens.report.mock.calls.map(([error]) => String(error))).toEqual([
			"Error: Conversation a threw where nothing caught it, after it began closing; the host carries on",
			"Error: Conversation a threw where nothing caught it, after it began closing; the host carries on",
		]);
	});
});

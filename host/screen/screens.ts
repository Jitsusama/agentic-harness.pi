/**
 * One persistent pi screen per hosted conversation. The engine tells this
 * module when a conversation opens, is rebound to a new id and closes; each
 * opening builds pi's own InteractiveMode over a ViewerTerminal, so the
 * screen keeps running with nobody watching and any number of viewers can
 * join it later. A screen that quits closes only its conversation; a window
 * closing only detaches its viewer.
 */

import { withSession } from "../../lib/core/session/index.ts";
import {
	type ViewerEdit,
	ViewerTerminal,
} from "../../lib/core/viewer/terminal.ts";
import type { ViewerBridge } from "../service/server.ts";
import { terminalBridge } from "../service/viewer.ts";

/** A conversation as the engine hands it to its screen. */
export interface HostedView {
	readonly sessionId: string;
	/** pi's AgentSessionRuntime, the runtimeHost InteractiveMode takes. */
	readonly runtime: unknown;
	/** Close this conversation in the host; the screen's quit calls it. */
	close(why: string): Promise<void>;
}

/** What the engine calls, under withSession, as conversations come and go. */
export interface EngineScreens {
	/** Settles once the screen has started and takes input, before the first words. */
	opened(view: HostedView): void | Promise<void>;
	rebound(view: HostedView, previousId: string): void | Promise<void>;
	closed(sessionId: string): void | Promise<void>;
}

/** One thing pi said as the conversation started, as its CLI shows it. */
export interface StartupDiagnostic {
	readonly type: "error" | "warning" | "info";
	readonly message: string;
}

/** The options a hosted InteractiveMode is built with. */
export interface HostedModeOptions {
	readonly terminal: ViewerTerminal;
	/**
	 * What pi said as the conversation started (extensions it couldn't
	 * load, invalid settings), which InteractiveMode shows as it starts, as
	 * pi's CLI hands it over; the screen keeps it for a viewer who joins
	 * later.
	 */
	readonly startupDiagnostics: readonly StartupDiagnostic[];
	readonly hosted: {
		onExit(exitCode: number, error?: unknown): Promise<void>;
		/** Ctrl+G: edit in the external editor of the viewer that pressed it. */
		editText(text: string): Promise<ViewerEdit>;
		/** Ctrl+Z: suspend only the viewer that pressed it, saying whether it could. */
		suspend(): boolean;
	};
}

/** What the host drives of a screen: start it, then run it until it quits. */
export interface HostedMode {
	/** Bind the conversation's extensions and input, as pi does before its first prompt. */
	init(): Promise<void>;
	/** Run the screen until it quits; starts it first if init has not. */
	run(): Promise<void>;
}

/** Builds one screen; production passes pi's InteractiveMode through hostedModeOf. */
export type HostedModeFactory = (
	runtime: unknown,
	options: HostedModeOptions,
) => HostedMode;

/** The screens of one host, and the bridge that lets viewers join them. */
export interface HostScreens {
	readonly screens: EngineScreens;
	readonly viewer: ViewerBridge;
	/** The ids with a live screen, for tests and the host's own listing. */
	ids(): string[];
}

interface Screen {
	readonly terminal: ViewerTerminal;
	readonly mode: HostedMode;
	readonly runtime: unknown;
	view: HostedView;
	/** Set once the conversation is closing, so its quit closes nothing twice. */
	closing: boolean;
}

/** Keep a screen for every conversation the engine opens. */
export function hostScreens(options: {
	create: HostedModeFactory;
	report: (error: unknown) => void;
}): HostScreens {
	const live = new Map<string, Screen>();

	function find(sessionId: string): Screen {
		const screen = live.get(sessionId);
		if (!screen) throw new Error(`Conversation has no screen: ${sessionId}`);
		return screen;
	}

	// The screen quit: close its conversation unless it is already closing.
	async function exited(screen: Screen, exitCode: number, error?: unknown) {
		if (error !== undefined) options.report(error);
		if (screen.closing) return;
		screen.closing = true;
		const why = exitCode === 0 ? "quit" : `screen ended with ${exitCode}`;
		await screen.view.close(why);
	}

	// The engine sends a conversation's first words once this settles, so the
	// screen starts first, as pi does before its own first prompt: otherwise
	// the words reach a screen that can't take input or show a panel yet.
	async function opened(view: HostedView): Promise<void> {
		if (live.has(view.sessionId))
			throw new Error(`Conversation already has a screen: ${view.sessionId}`);
		let screen: Screen | undefined;
		const terminal = new ViewerTerminal(view.sessionId, () => {
			if (screen) repaint(screen.mode);
		});
		const mode = options.create(view.runtime, {
			terminal,
			startupDiagnostics: diagnosticsOf(view.runtime),
			hosted: {
				onExit: (code, error) =>
					screen ? exited(screen, code, error) : Promise.resolve(),
				editText: (text) => terminal.editInViewer(text),
				suspend: () => terminal.suspendViewer(),
			},
		});
		screen = { terminal, mode, runtime: view.runtime, view, closing: false };
		live.set(view.sessionId, screen);
		try {
			await withSession(view.sessionId, () => mode.init());
		} catch (error) {
			// The engine fails the open itself, so the screen goes without closing.
			live.delete(view.sessionId);
			terminal.dispose();
			throw error;
		}
		const running = screen;
		withSession(view.sessionId, () => mode.run())
			.catch((error: unknown) => exited(running, 1, error))
			.catch(options.report);
	}

	function rebound(view: HostedView, previousId: string): void {
		const screen = find(previousId);
		if (view.runtime !== screen.runtime)
			throw new Error(
				`Conversation ${previousId} was rebound onto another runtime`,
			);
		live.delete(previousId);
		screen.view = view;
		live.set(view.sessionId, screen);
		screen.terminal.rebind(view.sessionId);
	}

	async function closed(sessionId: string): Promise<void> {
		const screen = live.get(sessionId);
		if (!screen) return;
		live.delete(sessionId);
		const quitting = screen.closing;
		screen.closing = true;
		try {
			if (!quitting) await stopScreen(screen.mode);
		} finally {
			screen.terminal.dispose();
		}
	}

	return {
		screens: { opened, rebound, closed },
		viewer: terminalBridge((sessionId) => find(sessionId).terminal),
		ids: () => [...live.keys()],
	};
}

/**
 * Adapt the InteractiveMode class a host's pi exports, refusing one without
 * the hosted lifecycle, whose screens would own the host's process exit.
 */
export function hostedModeOf(interactiveMode: unknown): HostedModeFactory {
	if (!isHostedModeClass(interactiveMode))
		throw new Error(
			"pi's InteractiveMode lacks the hosted lifecycle (pi-host-interactive-lifecycle.patch)",
		);
	return (runtime, options) => new interactiveMode(runtime, options);
}

type HostedModeClass = (new (
	runtime: unknown,
	options: HostedModeOptions,
) => HostedMode) & { readonly hostedLifecycleVersion: number };

function isHostedModeClass(value: unknown): value is HostedModeClass {
	return (
		typeof value === "function" &&
		"hostedLifecycleVersion" in value &&
		value.hostedLifecycleVersion === 1
	);
}

// The engine's runtime carries what its factory said; anything else said nothing.
function diagnosticsOf(runtime: unknown): StartupDiagnostic[] {
	const said =
		typeof runtime === "object" && runtime !== null && "diagnostics" in runtime
			? runtime.diagnostics
			: undefined;
	return Array.isArray(said) ? said.filter(isStartupDiagnostic) : [];
}

function isStartupDiagnostic(value: unknown): value is StartupDiagnostic {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		(value.type === "error" ||
			value.type === "warning" ||
			value.type === "info") &&
		"message" in value &&
		typeof value.message === "string"
	);
}

// pi keeps its renderer private; a host reads it without trusting its type.
// A viewer that has just joined holds none of the screen's images, so the
// repaint sends them again where pi's renderer can (the lifecycle patch's
// repaintForNewTerminal); an older pi's forced render places them only.
function repaint(mode: HostedMode): void {
	const ui = "ui" in mode ? mode.ui : undefined;
	if (typeof ui !== "object" || ui === null) return;
	if (
		"repaintForNewTerminal" in ui &&
		typeof ui.repaintForNewTerminal === "function"
	)
		ui.repaintForNewTerminal();
	else if ("requestRender" in ui && typeof ui.requestRender === "function")
		ui.requestRender(true);
}

// A conversation closed by the launcher or a host stop: end its screen the
// way pi's own quit does, which in a hosted screen exits only the screen.
async function stopScreen(mode: HostedMode): Promise<void> {
	if ("shutdown" in mode && typeof mode.shutdown === "function") {
		await mode.shutdown();
		return;
	}
	throw new Error("Conversation closed, but its screen has no way to stop");
}

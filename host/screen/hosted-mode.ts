/**
 * pi's hosted InteractiveMode as a host drives it: the options a screen is
 * built with, what the host calls of it, the check that the host's pi
 * carries core.nix's hosted lifecycle, and the reads of pi's private parts
 * (its renderer, editor, extension screen and shutdown) that a host makes
 * without trusting their type. This changes when pi changes; what a host
 * does with its screens lives in screens.ts.
 */

import type {
	ViewerEdit,
	ViewerTerminal,
} from "../../lib/core/viewer/terminal.ts";
import { isRecord } from "../../lib/internal/record.ts";
import type { StartupDiagnostic } from "../engine/index.ts";

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
		/**
		 * Ctrl+D, a double Ctrl+C, /quit or an extension's shutdown: whether
		 * the quit holds, asked of the viewer that typed it.
		 */
		quit(): Promise<boolean>;
	};
}

/** What the host drives of a screen: start it, then run it until it quits. */
export interface HostedMode {
	/** Bind the conversation's extensions and input, as pi does before its first prompt. */
	init(): Promise<void>;
	/** Run the screen until it quits; starts it first if init has not. */
	run(): Promise<void>;
	/** Show an error in the chat, as pi does when its first message fails. */
	showError?(message: string): void;
	/**
	 * pi's /reload: take down what the old load's extensions put on the
	 * screen, reload them, and bind the new load's. It says a failure on
	 * the screen rather than to its caller.
	 */
	handleReloadCommand?(): Promise<void>;
}

/** Builds one screen; production passes pi's InteractiveMode through hostedModeOf. */
export type HostedModeFactory = (
	runtime: unknown,
	options: HostedModeOptions,
) => HostedMode;

/**
 * Adapt the InteractiveMode class a host's pi exports, refusing one without
 * the hosted lifecycle, whose screens would own the host's process exit, or
 * without its hosted quit, whose screens would quit without asking the host.
 */
export function hostedModeOf(interactiveMode: unknown): HostedModeFactory {
	if (!isHostedModeClass(interactiveMode))
		throw new Error(
			"pi's InteractiveMode lacks the hosted lifecycle (pi-host-interactive-lifecycle.patch)",
		);
	if (interactiveMode.hostedQuit !== true)
		throw new Error(
			"pi's InteractiveMode lacks the hosted quit, which asks the host before a screen quits (pi-host-interactive-lifecycle.patch)",
		);
	return (runtime, options) => new interactiveMode(runtime, options);
}

type HostedModeClass = (new (
	runtime: unknown,
	options: HostedModeOptions,
) => HostedMode) & {
	readonly hostedLifecycleVersion: number;
	readonly hostedQuit?: unknown;
};

function isHostedModeClass(value: unknown): value is HostedModeClass {
	return (
		typeof value === "function" &&
		"hostedLifecycleVersion" in value &&
		value.hostedLifecycleVersion === 1
	);
}

/**
 * Draw a screen afresh for a viewer that has just joined. pi keeps its
 * renderer private, so a host reads it without trusting its type. Such a
 * viewer holds none of the screen's images, so the repaint sends them
 * again where pi's renderer can (the lifecycle patch's
 * repaintForNewTerminal); an older pi's forced render places them only.
 */
export function repaint(mode: HostedMode): void {
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

/**
 * Whether a screen shows pi's own editor focused and empty, with no
 * overlay, and its conversation is neither answering, compacting, running
 * a command nor holding a queued message. pi keeps its screen's parts
 * private, so a host reads them without trusting their type, and counts a
 * screen it can't read as busy: a pi that renamed them keeps its hosts
 * from restarting under the person, rather than restarting them over an
 * open panel.
 */
export function atRest(mode: HostedMode, runtime: unknown): boolean {
	const ui: unknown = Reflect.get(mode, "ui");
	const editor: unknown = Reflect.get(mode, "editor");
	const session: unknown = isRecord(runtime)
		? Reflect.get(runtime, "session")
		: undefined;
	if (!isRecord(ui) || !isRecord(editor) || !isRecord(session)) return false;
	return (
		called(ui, "getFocusedComponent") === editor &&
		called(ui, "hasOverlay") === false &&
		called(editor, "getText") === "" &&
		Reflect.get(session, "isStreaming") === false &&
		Reflect.get(session, "isCompacting") === false &&
		Reflect.get(session, "isBashRunning") === false &&
		Reflect.get(session, "pendingMessageCount") === 0
	);
}

/**
 * Whether the conversation is answering, compacting or running a command,
 * read as atRest reads it; one that can't be read counts as working.
 */
export function working(runtime: unknown): boolean {
	const session: unknown = isRecord(runtime)
		? Reflect.get(runtime, "session")
		: undefined;
	if (!isRecord(session)) return true;
	return (
		Reflect.get(session, "isStreaming") !== false ||
		Reflect.get(session, "isCompacting") !== false ||
		Reflect.get(session, "isBashRunning") !== false
	);
}

// What a method of `on` answers, or nothing when it has none.
function called(on: Record<string, unknown>, name: string): unknown {
	const method = on[name];
	return typeof method === "function"
		? Reflect.apply(method, on, [])
		: undefined;
}

/**
 * Take down what extensions put on a screen (footer, header, widgets,
 * dialogs, key listeners and statuses) by pi's own way, as its /reload
 * does before loading them again; private, so read without trusting it.
 * Says whether the screen had one.
 */
export function dropExtensionScreen(mode: HostedMode): boolean {
	if (!("resetExtensionUI" in mode)) return false;
	const reset = mode.resetExtensionUI;
	if (typeof reset !== "function") return false;
	reset.call(mode);
	return true;
}

/**
 * End a screen whose conversation the launcher or a host stop closed, the
 * way pi's own quit does, which in a hosted screen exits only the screen.
 */
export async function stopScreen(mode: HostedMode): Promise<void> {
	if ("shutdown" in mode && typeof mode.shutdown === "function") {
		await mode.shutdown();
		return;
	}
	throw new Error("Conversation closed, but its screen has no way to stop");
}

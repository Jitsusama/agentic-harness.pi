/**
 * One persistent pi screen per hosted conversation. The engine tells this
 * module when a conversation opens, is rebound to a new id and closes; each
 * opening builds pi's own InteractiveMode over a ViewerTerminal, so the
 * screen keeps running with nobody watching and any number of viewers can
 * join it later. A screen that quits closes only its conversation; a window
 * closing only detaches its viewer. A question pi asks before the screen
 * exists (whether to trust the project folder) is shown on the same
 * terminal, which viewers can already join, and the screen takes it over.
 * A dialog pi opens before anyone could attach tells the engine, so the
 * open answers and a viewer can join to reply; what fails after that is
 * shown on the screen.
 */

import { withSession } from "../../lib/core/session/index.ts";
import {
	type ViewerEdit,
	ViewerTerminal,
} from "../../lib/core/viewer/terminal.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { gatesDocked, gatesWaiting } from "../../lib/ui/screen-gates.ts";
import type { StartupDiagnostic } from "../engine/index.ts";
import type { ViewerBridge } from "../service/server.ts";
import { terminalBridge } from "../service/viewer.ts";
import type { StartupAsk, StartupAsker } from "./startup-ask.ts";

/** A conversation as the engine hands it to its screen. */
export interface HostedView {
	readonly sessionId: string;
	/** pi's AgentSessionRuntime, the runtimeHost InteractiveMode takes. */
	readonly runtime: unknown;
	/** Close this conversation in the host; the screen's quit calls it. */
	close(why: string): Promise<void>;
}

/** What a screen may tell the engine of the conversation it shows. */
export interface ScreenSignals {
	/** Something waits on the person, so the open should answer now. */
	asking(): void;
}

/** What the engine calls, under withSession, as conversations come and go. */
export interface EngineScreens {
	/** Settles once the screen has started and takes input, before the first words. */
	opened(view: HostedView, signals?: ScreenSignals): void | Promise<void>;
	rebound(view: HostedView, previousId: string): void | Promise<void>;
	closed(sessionId: string): void | Promise<void>;
	/**
	 * The build or first words failed after the open answered early: show
	 * it as pi shows a failed first message.
	 */
	failed(sessionId: string, message: string): void;
	/**
	 * Ask whether to trust the project folder before the conversation's
	 * screen exists, answering the label picked, or none when dismissed or
	 * closed first. Only screens given an asker have it.
	 */
	askProjectTrust?(
		sessionId: string,
		cwd: string,
		title: string,
		labels: readonly string[],
	): Promise<string | undefined>;
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
	/** Show an error in the chat, as pi does when its first message fails. */
	showError?(message: string): void;
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
	/**
	 * Whether every screen is at rest: started, showing pi's own editor
	 * empty and focused, with no panel, dialog or overlay over it, no gate
	 * docked or waiting for the screen, no command of the person's
	 * running, and nobody editing in their own editor. A host restarts only then, since a restart loses each of
	 * those (restart.ts).
	 */
	resting(): boolean;
}

interface Screen {
	readonly terminal: ViewerTerminal;
	readonly mode: HostedMode;
	readonly runtime: unknown;
	view: HostedView;
	/** Set once the conversation is closing, so its quit closes nothing twice. */
	closing: boolean;
	/** Set once pi's screen has started, and runs. */
	started: boolean;
}

/** A conversation's terminal, made before its screen when pi asks something first. */
interface Early {
	readonly terminal: ViewerTerminal;
	/** What a viewer joining is drawn by: the question, then the screen. */
	repaint: () => void;
	/** The question being asked, until it is answered. */
	asking: StartupAsk | undefined;
}

/** Keep a screen for every conversation the engine opens. */
export function hostScreens(options: {
	create: HostedModeFactory;
	report: (error: unknown) => void;
	/** Shows pi's startup questions; without it the screens offer none. */
	ask?: StartupAsker;
}): HostScreens {
	const live = new Map<string, Screen>();
	const early = new Map<string, Early>();

	function find(sessionId: string): Screen {
		const screen = live.get(sessionId);
		if (!screen) throw new Error(`Conversation has no screen: ${sessionId}`);
		return screen;
	}

	function terminalOf(sessionId: string): ViewerTerminal {
		const held = live.get(sessionId) ?? early.get(sessionId);
		if (!held) throw new Error(`Conversation has no screen: ${sessionId}`);
		return held.terminal;
	}

	// A terminal whose repaint follows whatever draws on it now.
	function earlyTerminal(sessionId: string): Early {
		const made: Early = {
			terminal: new ViewerTerminal(sessionId, () => made.repaint()),
			repaint: () => undefined,
			asking: undefined,
		};
		return made;
	}

	async function askProjectTrust(
		asker: StartupAsker,
		sessionId: string,
		title: string,
		labels: readonly string[],
	): Promise<string | undefined> {
		if (live.has(sessionId))
			throw new Error(`Conversation already has a screen: ${sessionId}`);
		// pi, or an extension deciding trust, may ask several in turn: each
		// after the last on the same terminal, never two at once.
		const before = early.get(sessionId);
		if (before?.asking)
			throw new Error(`Conversation is already asking: ${sessionId}`);
		const held = before ?? earlyTerminal(sessionId);
		early.set(sessionId, held);
		let asking: StartupAsk;
		try {
			asking = withSession(sessionId, () =>
				asker(held.terminal, title, labels),
			);
		} catch (error) {
			early.delete(sessionId);
			held.terminal.dispose();
			throw error;
		}
		held.asking = asking;
		held.repaint = () => asking.repaint();
		// Answered or cancelled, the terminal waits for its screen, or a close.
		const answer = await asking.answer;
		if (held.asking === asking) {
			held.asking = undefined;
			held.repaint = () => undefined;
		}
		return answer;
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
	async function opened(
		view: HostedView,
		signals?: ScreenSignals,
	): Promise<void> {
		if (live.has(view.sessionId))
			throw new Error(`Conversation already has a screen: ${view.sessionId}`);
		let screen: Screen | undefined;
		const held = early.get(view.sessionId) ?? earlyTerminal(view.sessionId);
		early.delete(view.sessionId);
		const { terminal } = held;
		// Nobody can attach until the open answers, so a dialog opened first,
		// even while the screen starts, would wait for good: the engine
		// answers once told, and ignores being told again.
		if (signals) terminal.whenBlocked(() => signals.asking());
		held.repaint = () => {
			if (screen) repaint(screen.mode);
		};
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
		screen = {
			terminal,
			mode,
			runtime: view.runtime,
			view,
			closing: false,
			started: false,
		};
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
		running.started = true;
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

	// The engine reports it too, so a conversation with no screen to show it
	// on loses nothing.
	function failed(sessionId: string, message: string): void {
		const mode = live.get(sessionId)?.mode;
		if (mode?.showError)
			withSession(sessionId, () => mode.showError?.(message));
	}

	async function closed(sessionId: string): Promise<void> {
		const held = early.get(sessionId);
		if (held) {
			early.delete(sessionId);
			held.asking?.cancel();
			held.terminal.dispose();
		}
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

	const { ask } = options;
	return {
		screens: {
			opened,
			rebound,
			closed,
			failed,
			...(ask
				? {
						askProjectTrust: (
							sessionId: string,
							_cwd: string,
							title: string,
							labels: readonly string[],
						) => askProjectTrust(ask, sessionId, title, labels),
					}
				: {}),
		},
		viewer: terminalBridge(terminalOf),
		ids: () => [...live.keys()],
		// A screen still starting, or a question asked before it, is in use.
		resting: () =>
			early.size === 0 &&
			[...live.values()].every(
				(screen) =>
					screen.started &&
					!screen.closing &&
					!screen.terminal.isEditing() &&
					atRest(screen.mode, screen.runtime) &&
					noGates(screen.view.sessionId),
			),
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

// pi keeps its screen's parts private, so a host reads them without
// trusting their type, and counts a screen it can't read as busy: a pi
// that renamed them keeps its hosts from restarting under the person,
// rather than restarting them over an open panel.
function atRest(mode: HostedMode, runtime: unknown): boolean {
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

// Gates keep their state on the conversation's screen (lib/ui), read in
// its session; a gate the person hopped away from shows nowhere else.
function noGates(sessionId: string): boolean {
	return withSession(
		sessionId,
		() => gatesDocked() === 0 && gatesWaiting() === 0,
	);
}

// What a method of `on` answers, or nothing when it has none.
function called(on: Record<string, unknown>, name: string): unknown {
	const method = on[name];
	return typeof method === "function"
		? Reflect.apply(method, on, [])
		: undefined;
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

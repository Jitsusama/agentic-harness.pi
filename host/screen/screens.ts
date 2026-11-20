/**
 * One persistent pi screen per hosted conversation. The engine tells this
 * module when a conversation opens, is rebound to a new id and closes; each
 * opening builds pi's own InteractiveMode over a ViewerTerminal, so the
 * screen keeps running with nobody watching and any number of viewers can
 * join it later. A screen that quits closes only its conversation, and a
 * quit a viewer typed holds only once that viewer confirms it, or else lets
 * that viewer go; a window closing only detaches its viewer. A conversation reloads through its
 * screen's /reload, as plain pi does, so what its old load drew never
 * outlives that load. A question pi asks before the screen
 * exists (whether to trust the project folder) is shown on the same
 * terminal, which viewers can already join, and the screen takes it over.
 * A dialog pi opens before anyone could attach tells the engine, so the
 * open answers and a viewer can join to reply; what fails after that is
 * shown on the screen. What one screen throws, from a frame, a key or a
 * timer of its own, ends only its conversation, never the host's process.
 * How a host builds pi's screen and reads its private parts lives beside
 * it in hosted-mode.ts.
 */

import { withSession } from "../../lib/core/session/index.ts";
import {
	CLOSED,
	RELEASED,
	ViewerTerminal,
} from "../../lib/core/viewer/terminal.ts";
import { gatesDocked, gatesWaiting } from "../../lib/ui/gate/screen-gates.ts";
import type { StartupDiagnostic } from "../engine/index.ts";
import type { ViewerBridge } from "../service/server.ts";
import { terminalBridge } from "../service/viewer.ts";
import {
	atRest,
	dropExtensionScreen,
	type HostedMode,
	type HostedModeFactory,
	repaint,
	stopScreen,
	working,
} from "./hosted-mode.ts";
import type { StartupAsk, StartupAsker } from "./startup-ask.ts";

// The host's program builds its screens from here.
export { hostedModeOf } from "./hosted-mode.ts";

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
	/** Its conversation closed, for `why` as the close gave it. */
	closed(sessionId: string, why?: string): void | Promise<void>;
	/**
	 * Park a conversation's screen: pi's screen stops, its viewers stay,
	 * shown it is parked, and what they type is kept for the screen it
	 * wakes into, the first key calling `wake`, which rejects with why a
	 * wake failed.
	 */
	parked(sessionId: string, wake: () => Promise<void>): Promise<void>;
	/** Reload an idle conversation's extensions as its screen's pi does at /reload. */
	reload(sessionId: string): Promise<void>;
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
	 * running, and nobody editing in their own editor. A host restarts
	 * only then, since a restart loses each of those (restart.ts).
	 */
	resting(): boolean;
	/**
	 * Contain what `sessionId`'s conversation threw where nothing caught it,
	 * saying whether it has a screen to contain it in.
	 */
	faulted(sessionId: string, error: unknown): boolean;
}

/** How many throws a conversation's screen has had contained. */
interface Faults {
	faults: number;
}

interface Screen extends Faults {
	readonly terminal: ViewerTerminal;
	/** What its terminal repaints through, which a park turns to its parked line. */
	readonly held: Early;
	readonly mode: HostedMode;
	readonly runtime: unknown;
	view: HostedView;
	/** Set once the conversation is closing, so its quit closes nothing twice. */
	closing: boolean;
	/** Set once pi's screen has started, and runs. */
	started: boolean;
	/** Who asked for the quit that held, for the reason it closes with. */
	quitBy?: string;
}

/** Throws reported of one screen; past these it is closing, and each frame would say the same. */
const FAULTS_REPORTED = 2;
/** What follows a throw from a screen already closing: nothing more. */
const CLOSING = "after it began closing";

/** A conversation's terminal, made before its screen when pi asks something first. */
interface Early {
	readonly terminal: ViewerTerminal;
	/** What a viewer joining is drawn by: the question, then the screen. */
	repaint: () => void;
	/** The question being asked, until it is answered. */
	asking: StartupAsk | undefined;
}

/** What a parked conversation's viewers see, as plain pi's parked window says it. */
export const PARKED_LINE =
	"Parked while idle, holding no memory. A key or a message wakes it.";

/** Keep a screen for every conversation the engine opens. */
export function hostScreens(options: {
	create: HostedModeFactory;
	report: (error: unknown) => void;
	/** Shows pi's startup questions; without it the screens offer none. */
	ask?: StartupAsker;
	/** Told how many windows view a conversation, each time one joins or leaves. */
	viewers?: (sessionId: string, count: number) => void;
}): HostScreens {
	const live = new Map<string, Screen>();
	const early = new Map<string, Early>();
	// Parked conversations' terminals, their viewers kept for the wake;
	// apart from early, since a parked conversation is at rest.
	const asleep = new Map<string, Early>();
	// Conversations whose screens closed, kept so a timer one left behind
	// that throws later is still its conversation's, not a reason to stop
	// the host; only their count, so no closed screen outlives its close.
	const gone = new Map<string, Faults>();

	function find(sessionId: string): Screen {
		const screen = live.get(sessionId);
		if (!screen) throw new Error(`Conversation has no screen: ${sessionId}`);
		return screen;
	}

	function terminalOf(sessionId: string): ViewerTerminal {
		const held =
			live.get(sessionId) ?? early.get(sessionId) ?? asleep.get(sessionId);
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
		// The terminal's own id, since a conversation that becomes another
		// keeps its terminal under the new id.
		made.terminal.whenViewed((count) =>
			options.viewers?.(made.terminal.sessionId, count),
		);
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
		const why =
			exitCode !== 0
				? `screen ended with ${exitCode}`
				: screen.quitBy
					? `quit, asked by ${screen.quitBy}`
					: "quit";
		await screen.view.close(why);
	}

	// A quit closes the conversation for everyone, so one a viewer typed
	// with others watching holds only once that viewer says so; a lone
	// viewer's holds as plain pi's does (ViewerTerminal.confirmQuit). One
	// asked as the conversation closes elsewhere already holds.
	async function quitHolds(screen: Screen | undefined): Promise<boolean> {
		if (!screen || screen.closing) return true;
		const verdict = await screen.terminal.confirmQuit(working(screen.runtime));
		if (verdict.holds) screen.quitBy = verdict.by;
		return verdict.holds;
	}

	// One conversation threw where nothing caught it: a frame, a key, a
	// resize, or a timer of its own. The first time, the screen takes down
	// what its extensions put on it, the likeliest cause, and says so; on 11
	// November a footer left by an earlier load threw on every frame and
	// ended the host. A second throw means the screen itself is broken, so
	// its conversation closes alone, its log kept for opening again.
	function contain(screen: Screen, error: unknown): void {
		noted(
			screen,
			screen.view.sessionId,
			screen.closing
				? CLOSING
				: screen.faults === 0
					? "so its extensions' screen comes down"
					: "so it closes",
			error,
		);
		if (screen.closing) return;
		if (screen.faults === 1 && settled(screen, error)) return;
		screen.closing = true;
		screen.view
			.close("its screen kept throwing")
			.catch((closing: unknown) => options.report(closing));
	}

	// Count a throw, and report the first few with what follows from it.
	function noted(
		counted: Faults,
		sessionId: string,
		then: string,
		error: unknown,
	): void {
		counted.faults += 1;
		if (counted.faults > FAULTS_REPORTED) return;
		options.report(
			new Error(
				`Conversation ${sessionId} threw where nothing caught it, ${then}; the host carries on`,
				{ cause: error },
			),
		);
	}

	// Take the extensions' footer, widgets, panels and key listeners down,
	// say why in the chat, and draw again, saying whether that went through.
	function settled(screen: Screen, error: unknown): boolean {
		const { mode, view } = screen;
		try {
			withSession(view.sessionId, () => {
				if (!dropExtensionScreen(mode)) throw error;
				const said = error instanceof Error ? error.message : String(error);
				mode.showError?.(
					`Something on this screen failed, so the extensions' footer, widgets and panels were taken down: ${said}. /reload puts them back.`,
				);
				repaint(mode);
			});
			return true;
		} catch (failed) {
			if (failed !== error) options.report(failed);
			return false;
		}
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
		const held =
			early.get(view.sessionId) ??
			asleep.get(view.sessionId) ??
			earlyTerminal(view.sessionId);
		early.delete(view.sessionId);
		asleep.delete(view.sessionId);
		gone.delete(view.sessionId);
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
				quit: () => quitHolds(screen),
			},
		});
		screen = {
			terminal,
			held,
			mode,
			runtime: view.runtime,
			view,
			closing: false,
			started: false,
			faults: 0,
		};
		const made = screen;
		terminal.whenFaulted((error) => contain(made, error));
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
		// Woken from a park: the keys that woke it, now that pi reads them.
		withSession(view.sessionId, () => terminal.awake());
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

	// pi's own /reload, so the old load's footer, widgets and listeners go
	// before pi invalidates that load, which every read of theirs would then
	// throw at, and the new load binds its keys and commands as on plain pi.
	async function reload(sessionId: string): Promise<void> {
		const { mode } = find(sessionId);
		if (!mode.handleReloadCommand)
			throw new Error("pi's screen has no /reload to reload it by");
		await withSession(sessionId, () => mode.handleReloadCommand?.());
	}

	async function closed(sessionId: string, why?: string): Promise<void> {
		// A release hands it back to plain pi, which its windows start; any
		// other end just ends them.
		const told = why?.startsWith("released") ? RELEASED : CLOSED;
		const held = early.get(sessionId) ?? asleep.get(sessionId);
		if (held) {
			early.delete(sessionId);
			asleep.delete(sessionId);
			held.asking?.cancel();
			held.terminal.dispose(told);
		}
		const screen = live.get(sessionId);
		if (!screen) return;
		live.delete(sessionId);
		// From here a throw is only counted, by its terminal and the host alike.
		const closed: Faults = { faults: screen.faults };
		gone.set(sessionId, closed);
		screen.terminal.whenFaulted((error) =>
			noted(closed, sessionId, CLOSING, error),
		);
		const quitting = screen.closing;
		screen.closing = true;
		try {
			if (!quitting) await stopScreen(screen.mode);
		} finally {
			screen.terminal.dispose(told);
		}
	}

	// Parking: pi's screen stops as at a close, but its terminal stays with
	// its viewers, holding what they type from before the stop, so no key
	// reaches the screen going away, and saying the conversation is parked.
	async function parked(
		sessionId: string,
		wake: () => Promise<void>,
	): Promise<void> {
		const screen = live.get(sessionId);
		if (!screen) return closed(sessionId);
		live.delete(sessionId);
		const { terminal } = screen;
		const kept: Faults = { faults: screen.faults };
		gone.set(sessionId, kept);
		terminal.whenFaulted((error) => noted(kept, sessionId, CLOSING, error));
		terminal.whenBlocked(undefined);
		terminal.sleep(wake);
		const quitting = screen.closing;
		screen.closing = true;
		try {
			if (!quitting) await stopScreen(screen.mode);
		} catch (error) {
			terminal.dispose();
			throw error;
		}
		screen.held.repaint = () => showParked(terminal);
		asleep.set(sessionId, screen.held);
		showParked(terminal);
	}

	const { ask } = options;
	return {
		screens: {
			opened,
			rebound,
			closed,
			parked,
			reload,
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
		faulted(sessionId, error) {
			const screen = live.get(sessionId);
			if (screen) contain(screen, error);
			const closed = screen ? undefined : gone.get(sessionId);
			if (closed) noted(closed, sessionId, CLOSING, error);
			return screen !== undefined || closed !== undefined;
		},
	};
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

// Gates keep their state on the conversation's screen (lib/ui), read in
// its session; a gate the person hopped away from shows nowhere else.
function noGates(sessionId: string): boolean {
	return withSession(
		sessionId,
		() => gatesDocked() === 0 && gatesWaiting() === 0,
	);
}

// A parked conversation's whole screen: the line saying so, at its top,
// the cursor shown, as plain pi's parked window leaves it.
function showParked(terminal: ViewerTerminal): void {
	terminal.write(`\x1b[2J\x1b[H${PARKED_LINE}\r\n`);
	terminal.showCursor();
}

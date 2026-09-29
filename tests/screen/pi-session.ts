/**
 * Real pi, on a terminal we can read back.
 *
 * `tests/lib/ui/pi-screen.ts` restates the few lines of pi that mount an
 * overlay, which is enough for a panel and not enough for a widget: a
 * widget's whole question is how it shares the screen with the transcript,
 * the editor and the footer, and only pi's own InteractiveMode lays those
 * out. So this boots InteractiveMode itself, from the pi this package is
 * typechecked against, over a headless xterm, with a faux model so a turn
 * can be scripted, and the extension under test handed in as a factory so
 * it shares this test's modules rather than a second copy jiti would load.
 *
 * Every frame pi paints is recorded with what pi believed it drew, and
 * `verdict` replays the bytes frame by frame into a fresh emulator. That is
 * what makes "no artefacts" a measurement rather than a glance at the
 * final screen: a desync, an overlong row or a blank row left behind by a
 * shrink is caught in the frame it happened, even if a later frame paints
 * over it. The rules are the plan's invariants (I2 desync, I7 blank rows,
 * I8 row hygiene), measured the way the verification campaign measured
 * them in the lab this was moved from.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import {
	type AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionContext,
	type InlineExtension,
	InteractiveMode,
	initTheme,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	StdinBuffer,
	setKittyProtocolActive,
	type Terminal,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { expect } from "vitest";

/** Resolves after `ms`. */
export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The escape and bell characters, spelled out so the patterns below are
 * built from them rather than written with control characters inline.
 */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** A control sequence: colours, cursor moves, modes. */
const CSI = new RegExp(`${ESC}\\[[0-9;?:]*[ -/]*[@-~]`, "g");
/** An operating system command, such as a hyperlink or a title. */
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(${BEL}|${ESC}\\\\)`, "g");
/** An application program command, which is how kitty graphics travel. */
const APC = new RegExp(`${ESC}_[^${ESC}]*${ESC}\\\\`, "g");
/** A sequence that moves the cursor, which a rendered line must not hold. */
const CURSOR_MOVE = new RegExp(`${ESC}\\[[0-9;]*[ABCDEFGHJfsu]`);

/** A rendered line with its escape sequences taken out. */
export function strip(line: string): string {
	return line.replace(CSI, "").replace(OSC, "").replace(APC, "");
}

/** Polls until `test` holds, and throws naming `what` if it never does. */
export async function waitFor(
	test: () => boolean | Promise<boolean>,
	what: string,
	ms = 8000,
): Promise<void> {
	const began = Date.now();
	while (Date.now() - began < ms) {
		if (await test()) return;
		await sleep(10);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/**
 * What a terminal sends for a key without the kitty protocol. Enough of
 * them for the scenarios here; add one when a scenario needs it.
 */
const LEGACY: Record<string, string> = {
	enter: "\r",
	escape: "\x1b",
	up: "\x1b[A",
	down: "\x1b[B",
	tab: "\t",
	backspace: "\x7f",
	"ctrl+c": "\x03",
	"ctrl+d": "\x04",
	"ctrl+s": "\x13",
	// What tmux and Terminal.app send for Ctrl+Enter: Enter.
	"ctrl+enter": "\r",
	"ctrl+alt+n": "\x1b\x0e",
};

/**
 * What a terminal sends for a key under the kitty protocol with the flags
 * pi asks for: a press, then a release. Enter, Tab and Backspace stay
 * legacy and send no release; a text key presses as text.
 */
const KITTY: Record<string, string[]> = {
	enter: ["\r"],
	"ctrl+enter": ["\x1b[13;5u", "\x1b[13;5:3u"],
	tab: ["\t"],
	backspace: ["\x7f"],
	escape: ["\x1b[27u", "\x1b[27;1:3u"],
	up: ["\x1b[A", "\x1b[1;1:3A"],
	down: ["\x1b[B", "\x1b[1;1:3B"],
	"ctrl+c": ["\x1b[99;5u", "\x1b[99;5:3u"],
	"ctrl+d": ["\x1b[100;5u", "\x1b[100;5:3u"],
	"ctrl+s": ["\x1b[115;5u", "\x1b[115;5:3u"],
	"ctrl+alt+n": ["\x1b[110;7u", "\x1b[110;7:3u"],
};

function encode(name: string, kitty: boolean): string[] {
	if (!kitty) return [LEGACY[name] ?? name];
	const known = KITTY[name];
	if (known) return known;
	if ([...name].length === 1) return [name, `\x1b[${name.codePointAt(0)};1:3u`];
	throw new Error(`no kitty encoding for ${name}`);
}

/**
 * pi-tui's terminal, written to a headless xterm and fed from pi's own
 * StdinBuffer, so a key reaches pi split the way a real read would be.
 */
class HeadlessTerminal implements Terminal {
	readonly emulator: xterm.Terminal;
	readonly writes: string[] = [];
	private readonly stdin = new StdinBuffer();
	private onInput?: (data: string) => void;
	private onResize?: () => void;

	constructor(
		private cols: number,
		private lines: number,
		readonly kitty: boolean,
	) {
		this.emulator = new xterm.Terminal({
			cols,
			rows: lines,
			scrollback: 100000,
			allowProposedApi: true,
		});
		this.stdin.on("data", (sequence) => this.onInput?.(sequence));
		this.stdin.on("paste", (content) =>
			this.onInput?.(`\x1b[200~${content}\x1b[201~`),
		);
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.onInput = onInput;
		this.onResize = onResize;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
		this.emulator.write(data);
	}
	get columns(): number {
		return this.cols;
	}
	get rows(): number {
		return this.lines;
	}
	get kittyProtocolActive(): boolean {
		return this.kitty;
	}
	moveBy(lines: number): void {
		if (lines > 0) this.write(`\x1b[${lines}B`);
		else if (lines < 0) this.write(`\x1b[${-lines}A`);
	}
	hideCursor(): void {
		this.write("\x1b[?25l");
	}
	showCursor(): void {
		this.write("\x1b[?25h");
	}
	clearLine(): void {
		this.write("\r\x1b[2K");
	}
	clearFromCursor(): void {
		this.write("\x1b[0J");
	}
	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}
	setTitle(): void {}
	setProgress(): void {}

	/** Whether the terminal changed size after it was made. */
	resized = false;

	resize(cols: number, rows: number): void {
		this.resized = true;
		this.cols = cols;
		this.lines = rows;
		this.emulator.resize(cols, rows);
		this.onResize?.();
	}

	/** Raw bytes, as one read from the terminal. */
	feed(data: string): void {
		this.stdin.process(data);
	}

	/** Every row in the buffer, scrollback included, once writes land. */
	async buffer(): Promise<{ rows: string[]; baseY: number }> {
		await new Promise<void>((resolve) => this.emulator.write("", resolve));
		const active = this.emulator.buffer.active;
		const rows: string[] = [];
		for (let i = 0; i < active.length; i++)
			rows.push(active.getLine(i)?.translateToString(true) ?? "");
		return { rows, baseY: active.baseY };
	}

	/** The rows on screen now. */
	async viewport(): Promise<string[]> {
		const { rows, baseY } = await this.buffer();
		return rows.slice(baseY, baseY + this.lines);
	}
}

/** How many sessions this process has dumped, to name each one's files. */
let dumped = 0;

/**
 * With `PI_SCREEN_DUMP` naming a directory, write what a session sent the
 * terminal and what the headless emulator made of it, for replaying into
 * a real terminal. This is the driven pass: the same bytes in WezTerm,
 * read back and compared with xterm's buffer, which is how a gap between
 * the two emulators would show. A session that was resized is marked, since
 * a replay into a pane of one size cannot reproduce it.
 */
async function dump(term: HeadlessTerminal): Promise<void> {
	const dir = process.env.PI_SCREEN_DUMP;
	if (!dir) return;
	mkdirSync(dir, { recursive: true });
	const { rows } = await term.buffer();
	const name = join(dir, `${process.pid}-${++dumped}`);
	writeFileSync(`${name}.bin`, term.writes.join(""));
	writeFileSync(
		`${name}.xterm.all.txt`,
		`${rows.map((row) => row.trimEnd()).join("\n")}\n`,
	);
	writeFileSync(
		`${name}.json`,
		JSON.stringify({
			test: expect.getState().currentTestName ?? "",
			cols: term.columns,
			rows: term.rows,
			resized: term.writes.length > 0 && term.resized,
		}),
	);
}

/** One painted frame: what pi believed it drew and where in the bytes. */
interface Frame {
	readonly at: number;
	readonly redraws: number;
	readonly top: number;
	readonly lines: string[];
	readonly cols: number;
	readonly rows: number;
	readonly label: string;
}

/** What the replay found wrong, frame by frame. */
export interface Verdict {
	readonly frames: number;
	/** Frames whose screen is not what pi believed it drew (I2). */
	readonly desync: string[];
	/** Rows with a newline, a cursor move or more columns than the width (I8). */
	readonly hygiene: string[];
	/** The most blank rows any frame left under its content (I7). */
	readonly blankMax: number;
	/** Where `blankMax` was first reached, as label#frame; empty for none. */
	readonly blankAt: string;
	/** Full redraws pi did after the first frame, by label. */
	readonly redrawsAt: string[];
}

/**
 * The parts of pi's TUI this harness reads. Private in pi's types, so they
 * are named here once, and a pi that renames one fails the harness's own
 * boot rather than every assertion downstream.
 */
interface PaintedTui {
	doRender(): void;
	fullRedrawCount: number;
	previousViewportTop?: number;
	previousLines: string[];
	focusedComponent?: unknown;
}

function isPaintedTui(value: unknown): value is PaintedTui {
	if (typeof value !== "object" || value === null) return false;
	return (
		typeof Reflect.get(value, "doRender") === "function" &&
		typeof Reflect.get(value, "fullRedrawCount") === "number" &&
		Array.isArray(Reflect.get(value, "previousLines"))
	);
}

/**
 * Whether `value` is pi-tui's TUI, by what a test reads of it. The class is
 * exported as a type only, so it cannot be checked with `instanceof`.
 */
function isTui(value: object): value is TUI {
	return (
		Array.isArray(Reflect.get(value, "children")) &&
		typeof Reflect.get(value, "requestRender") === "function" &&
		typeof Reflect.get(value, "setFocus") === "function" &&
		typeof Reflect.get(value, "terminal") === "object"
	);
}

/** What the harness reads of pi's editor. */
interface TextHolder {
	getText(): string;
}

function holdsText(value: unknown): value is TextHolder {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "getText") === "function"
	);
}

/** A booted pi and the means to drive and judge it. */
export interface PiSession {
	readonly term: HeadlessTerminal;
	readonly mode: InteractiveMode;
	/** Pi's own TUI, for a test that reads its component tree. */
	readonly tui: TUI;
	readonly runtime: AgentSessionRuntime;
	readonly faux: FauxProviderHandle;
	/** The context the extension saw at its last session start. */
	ctx(): ExtensionContext;
	/** Names the frames painted from here on, for the verdict. */
	mark(label: string): void;
	/** Presses a named key, releasing it too under kitty. */
	key(name: string): Promise<void>;
	/** Types text one key at a time. */
	type(text: string): Promise<void>;
	/** Types a prompt and submits it. */
	prompt(text: string): Promise<void>;
	/** Scripts the faux model's next answers. */
	answer(...texts: string[]): void;
	/** The editor's text. */
	editorText(): string;
	/** Whether the editor holds focus. */
	editorFocused(): boolean;
	/** The focused component. */
	focused(): unknown;
	/** The rows on screen now. */
	viewport(): Promise<string[]>;
	/** Whether any row on screen contains `text`. */
	onScreen(text: string): Promise<boolean>;
	/** How many rows of the whole buffer contain `text`. */
	inBuffer(text: string): Promise<number>;
	/** Replays every frame and reports what it found. */
	verdict(): Promise<Verdict>;
	/** The codes pi asked `process.exit` for, in order; it is stubbed. */
	exits(): readonly number[];
	/** Shuts pi down and puts the process back as it was. */
	stop(): Promise<void>;
}

/** How to boot. */
export interface BootOptions {
	readonly cols?: number;
	readonly rows?: number;
	/** Whether the terminal speaks the kitty keyboard protocol. */
	readonly kitty?: boolean;
	readonly extensions?: readonly InlineExtension[];
}

/**
 * Boots pi's InteractiveMode with `extensions` over a headless terminal.
 *
 * Stop it in `afterEach`: pi replaces `process.exit` on shutdown paths, and
 * this stubs it for the session's life so `/quit` in a scenario does not
 * end the test run.
 */
export async function bootPi(options: BootOptions = {}): Promise<PiSession> {
	const cols = options.cols ?? 100;
	const rows = options.rows ?? 30;
	const kitty = options.kitty ?? true;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-screen-agent-"));
	const savedEnv = {
		agent: process.env.PI_CODING_AGENT_DIR,
		offline: process.env.PI_OFFLINE,
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	setKittyProtocolActive(kitty);

	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "faux-1" }],
	});
	let seen: ExtensionContext | undefined;
	const harness: InlineExtension = {
		name: "screen-harness",
		hidden: true,
		factory: (pi) => {
			pi.registerProvider(faux.provider);
			pi.on("session_start", (_event, ctx) => {
				seen = ctx;
			});
		},
	};

	const runtime = await createAgentSessionRuntime(
		async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				resourceLoaderOptions: {
					noExtensions: true,
					extensionFactories: [harness, ...(options.extensions ?? [])],
					noSkills: true,
					noContextFiles: true,
					noPromptTemplates: true,
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
			});
			return { ...created, services, diagnostics: services.diagnostics };
		},
		{
			cwd: agentDir,
			agentDir,
			sessionManager: SessionManager.inMemory(agentDir),
		},
	);
	initTheme(undefined, true);
	const term = new HeadlessTerminal(cols, rows, kitty);
	const mode = new InteractiveMode(runtime, {
		terminal: term,
		tuiMode: "regular",
	});

	const realExit = process.exit;
	process.exit = ((code?: number) => {
		exits.push(code ?? 0);
	}) as typeof process.exit;
	const exits: number[] = [];
	const errors: string[] = [];
	const onRejection = (reason: unknown) =>
		errors.push(`unhandled rejection: ${String(reason)}`);
	process.on("unhandledRejection", onRejection);
	mode.run().catch((error: unknown) => errors.push(`run: ${String(error)}`));
	await waitFor(() => seen !== undefined, "the extension to load", 15000);
	await runtime.session.setModel(faux.getModel());

	const tui: unknown = Reflect.get(mode, "ui");
	if (!isPaintedTui(tui) || !isTui(tui))
		throw new Error("pi's TUI no longer exposes what the harness reads");
	const frames: Frame[] = [];
	const redrawsAt: string[] = [];
	let label = "";
	let redraws = tui.fullRedrawCount;
	const paint = tui.doRender.bind(tui);
	tui.doRender = () => {
		paint();
		if (tui.fullRedrawCount > redraws && frames.length > 0)
			redrawsAt.push(`${label}#${frames.length}`);
		redraws = tui.fullRedrawCount;
		frames.push({
			at: term.writes.length,
			redraws,
			top: tui.previousViewportTop ?? 0,
			lines: tui.previousLines.slice(),
			cols: term.columns,
			rows: term.rows,
			label,
		});
	};

	const key = async (name: string): Promise<void> => {
		for (const sequence of encode(name, kitty)) term.feed(sequence);
		// A lone legacy Escape is held by StdinBuffer for its timeout.
		await sleep(!kitty && name === "escape" ? 120 : 20);
	};
	const type = async (text: string): Promise<void> => {
		for (const character of text)
			for (const sequence of encode(character, kitty)) term.feed(sequence);
		await sleep(30);
	};

	const verdict = async (): Promise<Verdict> => {
		const first = frames[0];
		const replay = new xterm.Terminal({
			cols: first?.cols ?? cols,
			rows: first?.rows ?? rows,
			scrollback: 100000,
			allowProposedApi: true,
		});
		const put = (bytes: string) =>
			new Promise<void>((resolve) => replay.write(bytes, resolve));
		const desync: string[] = [];
		const hygiene: string[] = [];
		let blankMax = 0;
		let blankAt = "";
		let at = 0;
		for (const [index, frame] of frames.entries()) {
			if (replay.cols !== frame.cols || replay.rows !== frame.rows)
				replay.resize(frame.cols, frame.rows);
			await put(term.writes.slice(at, frame.at).join(""));
			at = frame.at;
			const active = replay.buffer.active;
			const believed = frame.lines
				.slice(frame.top)
				.map((line) => strip(line).trimEnd());
			for (let row = 0; row < frame.rows; row++) {
				const shown =
					active
						.getLine(active.baseY + row)
						?.translateToString(true)
						.trimEnd() ?? "";
				if ((believed[row] ?? "") !== shown) {
					desync.push(
						`${frame.label}#${index} row ${row}: pi drew ${JSON.stringify(believed[row] ?? "")}, screen shows ${JSON.stringify(shown)}`,
					);
					break;
				}
			}
			for (const [row, line] of frame.lines.entries()) {
				if (
					/[\n\r]/.test(line) ||
					CURSOR_MOVE.test(line) ||
					visibleWidth(line) > frame.cols
				) {
					hygiene.push(
						`${frame.label}#${index} line ${row}: ${JSON.stringify(strip(line)).slice(0, 80)}`,
					);
					break;
				}
			}
			const drawn = frame.lines.length - frame.top;
			const blank = Math.max(
				0,
				Math.min(frame.rows, frame.lines.length) - drawn,
			);
			if (blank > blankMax) {
				blankMax = blank;
				blankAt = `${frame.label}#${index}`;
			}
		}
		replay.dispose();
		return {
			frames: frames.length,
			desync,
			hygiene,
			blankMax,
			blankAt,
			redrawsAt,
		};
	};

	// Pi's editor, which InteractiveMode keeps private. Read on every call,
	// since an extension can replace it.
	const editor = (): TextHolder => {
		const held: unknown = Reflect.get(mode, "editor");
		if (!holdsText(held))
			throw new Error("pi's InteractiveMode no longer holds an editor");
		return held;
	};

	return {
		term,
		mode,
		tui,
		runtime,
		faux,
		ctx: () => {
			if (!seen) throw new Error("no session has started");
			return seen;
		},
		mark: (name) => {
			label = name;
		},
		key,
		type,
		prompt: async (text) => {
			await type(text);
			await key("enter");
		},
		answer: (...texts) =>
			faux.setResponses(texts.map((text) => fauxAssistantMessage(text))),
		editorText: () => editor().getText(),
		editorFocused: () => tui.focusedComponent === editor(),
		focused: () => tui.focusedComponent,
		viewport: () => term.viewport(),
		onScreen: async (text) =>
			(await term.viewport()).some((row) => row.includes(text)),
		inBuffer: async (text) =>
			(await term.buffer()).rows.filter((row) => row.includes(text)).length,
		verdict,
		exits: () => exits,
		stop: async () => {
			await dump(term);
			try {
				mode.stop();
				await runtime.dispose();
			} finally {
				process.off("unhandledRejection", onRejection);
				process.exit = realExit;
				process.env.PI_CODING_AGENT_DIR = savedEnv.agent;
				process.env.PI_OFFLINE = savedEnv.offline;
				if (savedEnv.agent === undefined)
					delete process.env.PI_CODING_AGENT_DIR;
				if (savedEnv.offline === undefined) delete process.env.PI_OFFLINE;
				term.emulator.dispose();
			}
			if (errors.length > 0) throw new Error(errors.join("\n"));
		},
	};
}

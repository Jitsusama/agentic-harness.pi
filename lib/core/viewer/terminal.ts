/** A persistent pi terminal whose viewers never own the conversation. */
import {
	formatProgramStatus,
	type ProgramStatus,
	StdinBuffer,
	setKittyProtocolActive,
	type Terminal,
} from "@earendil-works/pi-tui";
import { withSession } from "../session/index.ts";
import { TerminalModes } from "./modes.ts";

const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;
const MAX_DIMENSION = 1000;
const MAX_PENDING_INPUT_BYTES = 1024 * 1024;
const ESCAPE_TIMEOUT_MS = 50;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** The largest draft sent to edit, as JSON, well inside a 1 MiB frame. */
const MAX_EDIT_BYTES = 1000 * 1024;

/** How an edit in a viewer's editor came back, in the shape pi's own editor answers. */
export type ViewerEdit =
	| { readonly status: "complete"; readonly content: string }
	| { readonly status: "failed"; readonly message: string };

const UNAVAILABLE: ViewerEdit = {
	status: "failed",
	message: "The external editor is unavailable in this viewer",
};
const TOO_LARGE: ViewerEdit = {
	status: "failed",
	message: "The draft is too large to edit in the viewer",
};
const GAVE_NOTHING: ViewerEdit = {
	status: "failed",
	message: "The external editor gave nothing back; the draft is kept",
};
const LEFT: ViewerEdit = {
	status: "failed",
	message: "The viewer left before its edit came back",
};

/** One viewer's dimensions and non-blocking output sink, owned by H2. */
export interface Viewer {
	rows: number;
	columns: number;
	write(data: string): void;
	disconnect(reason: string): void;
	/** What its client said it can do as it attached, such as edit and suspend. */
	readonly features?: readonly string[];
	/** Ask its client to edit `text` in its own terminal; it answers through `edited`. */
	edit?(id: string, text: string): void;
	/** Tell its client to suspend itself, and let the connection go. */
	suspend?(): void;
}

/** Input and lifetime of one connection, not the conversation. */
export interface Attachment {
	input(data: string): void;
	resize(rows: number, columns: number): void;
	/**
	 * Its client's answer to the edit `id`: what the draft became, or nothing
	 * to keep it. An answer to no edit it was asked, or a late one, is dropped.
	 */
	edited(id: string, text?: string): void;
	detach(): void;
}

interface JoinedViewer {
	sink: Viewer;
	rows: number;
	columns: number;
	stdin: StdinBuffer;
	pendingBytes: number;
	/** The edit its client is running, during which it is sent nothing and types nothing. */
	editing: { readonly id: string; settle(edit: ViewerEdit): void } | undefined;
}

function can(viewer: JoinedViewer, feature: string): boolean {
	return viewer.sink.features?.includes(feature) ?? false;
}

// What pi's own editor makes of the file it read back.
function asPiReadsIt(text: string): string {
	return text.replace(/^\uFEFF/, "").replace(/\n$/, "");
}

function validSize(rows: number, columns: number): boolean {
	return [rows, columns].every(
		(value) => Number.isInteger(value) && value >= 1 && value <= MAX_DIMENSION,
	);
}

/** A kitty terminal kept alive even when nobody is watching. */
export class ViewerTerminal implements Terminal {
	columns = DEFAULT_COLUMNS;
	rows = DEFAULT_ROWS;
	readonly kittyProtocolActive = true;
	private readonly viewers = new Set<JoinedViewer>();
	private readonly modes = new TerminalModes();
	private closed = false;
	private onInput: ((data: string) => void) | undefined;
	private onResize: (() => void) | undefined;
	/** The viewer whose keys came last: the one that pressed what pi acts on. */
	private lastTyped: JoinedViewer | undefined;
	private edits = 0;
	/** Told each time pi says something waits on the person. */
	private blocked: (() => void) | undefined;
	/** Told what one of pi's callbacks threw, in place of the host's process. */
	private faulted: ((error: unknown) => void) | undefined;

	private currentSession: string;
	private readonly repaint: () => void;

	constructor(sessionId: string, repaint: () => void) {
		this.currentSession = sessionId;
		this.repaint = repaint;
	}

	/** The conversation every callback runs in. */
	get sessionId(): string {
		return this.currentSession;
	}

	/**
	 * Follow the conversation to its new id after pi replaced its session (a new
	 * session, a fork, a resume), keeping every viewer and repainting for them.
	 */
	rebind(sessionId: string): void {
		this.currentSession = sessionId;
		this.inConversation(() => this.repaint());
	}

	/** Bind pi's callbacks, always dispatching in this conversation. */
	start(input: (data: string) => void, resize: () => void): void {
		this.onInput = input;
		this.onResize = resize;
		// pi's key reader reads kitty's keys, a line feed as Shift+Enter among
		// them, only once told its terminal speaks kitty's protocol, as pi's own
		// terminal tells it when kitty answers. Every viewer is told to speak it.
		// The flag is the process's, shared by the host's other screens, so no
		// one screen's stop turns it off.
		setKittyProtocolActive(true);
	}

	/** Stop input for renderer teardown; this does not close the session. */
	stop(): void {
		this.onInput = undefined;
		this.onResize = undefined;
		for (const viewer of this.viewers) {
			viewer.stdin.clear();
			viewer.pendingBytes = 0;
		}
		this.showCursor();
	}

	/** Connect an H2 sink; detach destroys only that viewer's input buffer. */
	attach(sink: Viewer): Attachment {
		if (this.closed) throw new Error("Conversation closed");
		if (!validSize(sink.rows, sink.columns))
			throw new Error("Viewer dimensions must be integers from 1 to 1000");
		const viewer: JoinedViewer = {
			sink,
			rows: sink.rows,
			columns: sink.columns,
			stdin: new StdinBuffer({ escapeTimeout: ESCAPE_TIMEOUT_MS }),
			pendingBytes: 0,
			editing: undefined,
		};
		const deliver = (data: string) => {
			viewer.pendingBytes = 0;
			if (!this.viewers.has(viewer)) return;
			this.lastTyped = viewer;
			this.inConversation(() => this.onInput?.(data));
		};
		viewer.stdin.on("data", deliver);
		viewer.stdin.on("paste", (data) =>
			deliver(`${PASTE_START}${data}${PASTE_END}`),
		);
		try {
			sink.write(this.modes.restored());
		} catch (error) {
			viewer.stdin.destroy();
			throw new Error("Viewer output failed", { cause: error });
		}
		this.viewers.add(viewer);
		this.redraw();
		return {
			input: (data) => {
				if (!this.viewers.has(viewer) || !this.onInput || viewer.editing)
					return;
				viewer.pendingBytes += Buffer.byteLength(data);
				if (viewer.pendingBytes > MAX_PENDING_INPUT_BYTES) {
					this.remove(viewer);
					this.disconnect(
						viewer,
						"Viewer input exceeded 1 MiB without a complete event",
					);
					return;
				}
				viewer.stdin.process(data);
			},
			resize: (rows, columns) => {
				if (!this.viewers.has(viewer)) return;
				if (!validSize(rows, columns)) {
					this.remove(viewer);
					this.disconnect(
						viewer,
						"Viewer dimensions must be integers from 1 to 1000",
					);
					return;
				}
				viewer.rows = rows;
				viewer.columns = columns;
				this.redraw();
			},
			edited: (id, text) => this.edited(viewer, id, text),
			detach: () => this.remove(viewer),
		};
	}

	/** Whether a viewer is editing a draft in its own editor now. */
	isEditing(): boolean {
		return [...this.viewers].some((viewer) => viewer.editing !== undefined);
	}

	/**
	 * Edit `text` in the external editor of the viewer that typed last, in its
	 * own terminal, while the screen runs on for the others: that viewer is
	 * let out of pi's modes and sent nothing until its client answers, then
	 * given them back and repainted. A viewer whose client can't is refused,
	 * and one that leaves first keeps the draft.
	 */
	editInViewer(text: string): Promise<ViewerEdit> {
		const viewer = this.lastTyped;
		const edit = viewer?.sink.edit;
		if (
			!viewer ||
			!edit ||
			!this.viewers.has(viewer) ||
			!can(viewer, "edit") ||
			viewer.editing
		)
			return Promise.resolve(UNAVAILABLE);
		if (Buffer.byteLength(JSON.stringify(text)) > MAX_EDIT_BYTES)
			return Promise.resolve(TOO_LARGE);
		const id = String(++this.edits);
		return new Promise((settle) => {
			viewer.editing = { id, settle };
			try {
				viewer.sink.write(this.modes.released());
				edit.call(viewer.sink, id, text);
			} catch {
				// A broken connection is a viewer that left; its edit keeps the draft.
				this.remove(viewer);
				this.disconnect(viewer, "Viewer output failed");
			}
		});
	}

	/**
	 * Suspend the viewer that typed last, as Ctrl+Z suspends pi: its client is
	 * let out of pi's modes, told to stop itself, and let go, while the
	 * conversation runs on. Says whether it could; a client that can't is
	 * left watching.
	 */
	suspendViewer(): boolean {
		const viewer = this.lastTyped;
		const suspend = viewer?.sink.suspend;
		if (
			!viewer ||
			!suspend ||
			!this.viewers.has(viewer) ||
			!can(viewer, "suspend")
		)
			return false;
		try {
			viewer.sink.write(this.modes.released());
			suspend.call(viewer.sink);
		} catch {
			// A connection that broke as it was let go has gone all the same.
		}
		this.remove(viewer);
		return true;
	}

	/** H2 bounds queued output; one broken sink never blocks the other viewers. */
	write(data: string): void {
		this.modes.saw(data);
		for (const viewer of [...this.viewers]) {
			// Its editor has its terminal; the repaint after brings it up to date.
			if (viewer.editing) continue;
			try {
				viewer.sink.write(data);
			} catch {
				// A broken connection is only a detached viewer, not a pi crash.
				this.remove(viewer);
				this.disconnect(viewer, "Viewer output failed");
			}
		}
	}

	/** The client drains its own tty when disconnecting; the host owns none. */
	async drainInput(): Promise<void> {}

	moveBy(lines: number): void {
		if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`);
	}
	hideCursor(): void {
		this.write("\x1b[?25l");
	}
	showCursor(): void {
		this.write("\x1b[?25h");
	}
	clearLine(): void {
		this.write("\x1b[2K");
	}
	clearFromCursor(): void {
		this.write("\x1b[0J");
	}
	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}
	setTitle(title: string): void {
		this.write(`\x1b]0;${title.replace(/\p{Cc}/gu, " ")}\x07`);
	}
	setProgress(active: boolean): void {
		this.write(`\x1b]9;4;${active ? "3" : "0"};\x07`);
	}
	setProgramStatus(status: ProgramStatus): void {
		this.write(formatProgramStatus(status));
		if (status.state === "blocked") this.blocked?.();
	}

	/**
	 * Draw one of pi's frames as the conversation this screen shows. A frame
	 * is asked for from wherever its cause ran, such as another conversation
	 * that changed the theme every screen listens to, so what a component
	 * reads from its conversation while drawing would otherwise be that one's.
	 * A pi without the host's render scope never calls this.
	 */
	renderScope(draw: () => void): void {
		this.inConversation(draw);
	}

	/**
	 * Call `listener` with whatever one of pi's frames, keys or resizes
	 * throws on this terminal, rather than letting it escape to the host's
	 * process, where it would end every conversation the host holds.
	 * Undefined lets a throw go on up, as it does before any is set.
	 */
	whenFaulted(listener: ((error: unknown) => void) | undefined): void {
		this.faulted = listener;
	}

	/**
	 * Call `listener` each time pi says something waits on the person, such
	 * as an extension's dialog or a login, as it tells any terminal through
	 * its program status; undefined stops it. A custom overlay an extension
	 * shows says nothing, so it is never heard.
	 */
	whenBlocked(listener: (() => void) | undefined): void {
		this.blocked = listener;
	}

	/** Free connection buffers when the conversation itself closes. */
	dispose(): void {
		this.closed = true;
		this.onInput = undefined;
		this.onResize = undefined;
		this.blocked = undefined;
		// The fault listener stays: pi's renderer may draw once more after a
		// close, and that frame's throw is still this conversation's.
		const viewers = [...this.viewers];
		this.viewers.clear();
		for (const viewer of viewers) {
			viewer.stdin.destroy();
			this.cancelEdit(viewer);
			this.disconnect(viewer, "Conversation closed");
		}
	}

	private edited(viewer: JoinedViewer, id: string, text?: string): void {
		const pending = viewer.editing;
		if (!pending || pending.id !== id || !this.viewers.has(viewer)) return;
		viewer.editing = undefined;
		pending.settle(
			text === undefined
				? GAVE_NOTHING
				: { status: "complete", content: asPiReadsIt(text) },
		);
		try {
			viewer.sink.write(this.modes.restored());
		} catch {
			// A broken connection is only a detached viewer, not a pi crash.
			this.remove(viewer);
			this.disconnect(viewer, "Viewer output failed");
			return;
		}
		this.inConversation(() => this.repaint());
	}

	private cancelEdit(viewer: JoinedViewer): void {
		const pending = viewer.editing;
		viewer.editing = undefined;
		pending?.settle(LEFT);
	}

	private disconnect(viewer: JoinedViewer, reason: string): void {
		try {
			viewer.sink.disconnect(reason);
		} catch {
			// Already detached locally; failed connection cleanup cannot affect siblings.
		}
	}

	private remove(viewer: JoinedViewer): void {
		if (!this.viewers.delete(viewer)) return;
		if (this.lastTyped === viewer) this.lastTyped = undefined;
		viewer.stdin.destroy();
		this.cancelEdit(viewer);
		this.redraw();
	}

	private redraw(): void {
		const oldRows = this.rows;
		const oldColumns = this.columns;
		if (this.viewers.size > 0) {
			this.rows = Math.min(...[...this.viewers].map((viewer) => viewer.rows));
			this.columns = Math.min(
				...[...this.viewers].map((viewer) => viewer.columns),
			);
		}
		this.inConversation(() => {
			if (this.rows !== oldRows || this.columns !== oldColumns)
				this.onResize?.();
			this.repaint();
		});
	}

	// Every one of pi's callbacks runs as this conversation, and what it
	// throws goes to the fault listener when there is one.
	private inConversation(call: () => void): void {
		try {
			withSession(this.currentSession, call);
		} catch (error) {
			const faulted = this.faulted;
			if (!faulted) throw error;
			withSession(this.currentSession, () => faulted(error));
		}
	}
}

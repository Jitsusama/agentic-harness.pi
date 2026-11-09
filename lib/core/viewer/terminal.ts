/** A persistent pi terminal whose viewers never own the conversation. */
import {
	formatProgramStatus,
	type ProgramStatus,
	StdinBuffer,
	type Terminal,
} from "@earendil-works/pi-tui";
import { withSession } from "../session/index.ts";

const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;
const MAX_DIMENSION = 1000;
const MAX_PENDING_INPUT_BYTES = 1024 * 1024;
const ESCAPE_TIMEOUT_MS = 50;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** One viewer's dimensions and non-blocking output sink, owned by H2. */
export interface Viewer {
	rows: number;
	columns: number;
	write(data: string): void;
	disconnect(reason: string): void;
}

/** Input and lifetime of one connection, not the conversation. */
export interface Attachment {
	input(data: string): void;
	resize(rows: number, columns: number): void;
	detach(): void;
}

interface JoinedViewer {
	sink: Viewer;
	rows: number;
	columns: number;
	stdin: StdinBuffer;
	pendingBytes: number;
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
	private closed = false;
	private onInput: ((data: string) => void) | undefined;
	private onResize: (() => void) | undefined;

	readonly sessionId: string;
	private readonly repaint: () => void;

	constructor(sessionId: string, repaint: () => void) {
		this.sessionId = sessionId;
		this.repaint = repaint;
	}

	/** Bind pi's callbacks, always dispatching in this conversation. */
	start(input: (data: string) => void, resize: () => void): void {
		this.onInput = input;
		this.onResize = resize;
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
		};
		const deliver = (data: string) => {
			viewer.pendingBytes = 0;
			if (this.viewers.has(viewer))
				withSession(this.sessionId, () => this.onInput?.(data));
		};
		viewer.stdin.on("data", deliver);
		viewer.stdin.on("paste", (data) =>
			deliver(`${PASTE_START}${data}${PASTE_END}`),
		);
		this.viewers.add(viewer);
		this.redraw();
		return {
			input: (data) => {
				if (!this.viewers.has(viewer) || !this.onInput) return;
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
				if (!validSize(rows, columns))
					throw new Error("Viewer dimensions must be integers from 1 to 1000");
				viewer.rows = rows;
				viewer.columns = columns;
				this.redraw();
			},
			detach: () => this.remove(viewer),
		};
	}

	/** H2 bounds queued output; one broken sink never blocks the other viewers. */
	write(data: string): void {
		for (const viewer of [...this.viewers]) {
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
	}

	/** Free connection buffers when the conversation itself closes. */
	dispose(): void {
		this.closed = true;
		this.onInput = undefined;
		this.onResize = undefined;
		const viewers = [...this.viewers];
		this.viewers.clear();
		for (const viewer of viewers) {
			viewer.stdin.destroy();
			this.disconnect(viewer, "Conversation closed");
		}
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
		viewer.stdin.destroy();
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
		withSession(this.sessionId, () => {
			if (this.rows !== oldRows || this.columns !== oldColumns)
				this.onResize?.();
			this.repaint();
		});
	}
}

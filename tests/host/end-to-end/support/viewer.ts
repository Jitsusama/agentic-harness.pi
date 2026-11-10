/**
 * A viewer as mycelium's attach client is one: a connection to a host's
 * socket that attaches to one conversation, sends what is typed and each
 * resize as frames, and hands the host's output to a terminal. The
 * terminal here is xterm's headless one, so a test reads the screen the
 * viewer would see, with its modes, rather than the bytes that drew it.
 */

import { connect, type Socket } from "node:net";
import xterm from "@xterm/headless";

/** How long a wait for the screen may take before it fails, saying what was shown. */
const SHOWN_MS = 15_000;

/**
 * A frame the host sends a viewer once attached: output, why it was let go,
 * an edit to run, a suspend, or a kind not read here.
 */
interface Frame {
	readonly type: string;
	readonly data?: string;
	readonly reason?: string;
	readonly id?: string;
	readonly text?: string;
}

function frameOf(line: object): Frame {
	const field = (name: string) => {
		const value: unknown = Reflect.get(line, name);
		return typeof value === "string" ? value : undefined;
	};
	return {
		type: field("type") ?? "",
		data: field("data"),
		reason: field("reason"),
		id: field("id"),
		text: field("text"),
	};
}

/** What a viewer's client can do, as mycelium's says when it attaches. */
export interface Abilities {
	/** The features it declares, such as edit and suspend. */
	readonly features?: readonly string[];
	/** Its external editor: what the draft becomes, or undefined when it gives nothing back. */
	readonly editor?: (text: string) => string | undefined;
}

/** One viewer of one conversation. */
export interface Viewer {
	/** The terminal its output is drawn on. */
	readonly terminal: xterm.Terminal;
	/** Every output frame, in order, as sent. */
	readonly output: readonly string[];
	/** Send what was typed, as the bytes a terminal sends. */
	type(data: string): void;
	/** Tell the host the window is now this size. */
	resize(rows: number, columns: number): void;
	/** The screen as it reads now: one string per row, trailing space dropped. */
	screen(): string[];
	/** Wait until the screen shows `wanted`, failing with what it shows instead. */
	shows(wanted: string | RegExp, ms?: number): Promise<void>;
	/** Wait until the output sent so far holds `wanted`. */
	sent(wanted: string | RegExp, ms?: number): Promise<void>;
	/** Why the host let it go, once it does. */
	readonly detached: Promise<string>;
	/** Each draft the host asked its editor to edit, in order. */
	readonly edits: readonly string[];
	/** Settles once the host tells it to suspend itself. */
	readonly suspended: Promise<void>;
	/** Close the window: end the connection without a word. */
	leave(): Promise<void>;
}

/** Attach a viewer of `rows` by `columns` to `sessionId` through the socket at `path`. */
export async function attach(
	path: string,
	sessionId: string,
	rows: number,
	columns: number,
	abilities: Abilities = {},
): Promise<Viewer> {
	const terminal = new xterm.Terminal({
		rows,
		cols: columns,
		allowProposedApi: true,
		scrollback: 1000,
	});
	const socket = connect(path);
	const output: string[] = [];
	const watchers = new Set<() => void>();
	let detach: (reason: string) => void = () => undefined;
	const detached = new Promise<string>((done) => {
		detach = done;
	});
	const edits: string[] = [];
	let suspend: () => void = () => undefined;
	const suspended = new Promise<void>((done) => {
		suspend = done;
	});
	const send = (value: object) => socket.write(`${JSON.stringify(value)}\n`);
	// Made once, so a viewer that already left, or was let go, leaves at once.
	const closed = new Promise<void>((done) =>
		socket.once("close", () => {
			detach("connection closed");
			done();
		}),
	);
	const geometry = { rows, columns, features: abilities.features };
	const reply = await attached(socket, sessionId, geometry, (frame) => {
		const { type, data, reason, id, text } = frame;
		if (type === "output" && data !== undefined) {
			output.push(data);
			terminal.write(data, () => {
				for (const watcher of [...watchers]) watcher();
			});
		} else if (type === "detached" && reason !== undefined) {
			detach(reason);
		} else if (type === "edit" && id !== undefined && text !== undefined) {
			// The client runs its editor with its relay paused, then answers.
			edits.push(text);
			send({ type: "edited", id, text: abilities.editor?.(text) });
		} else if (type === "suspend") {
			suspend();
		}
	});
	if (!reply.ok) throw new Error(`attach refused: ${JSON.stringify(reply)}`);
	const screen = () => {
		const buffer = terminal.buffer.active;
		return Array.from(
			{ length: terminal.rows },
			(_, row) =>
				buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
		);
	};
	const until = (holds: () => boolean, what: () => string, ms: number) =>
		new Promise<void>((done, fail) => {
			if (holds()) return done();
			const timer = setTimeout(() => {
				watchers.delete(check);
				fail(new Error(what()));
			}, ms);
			const check = () => {
				if (!holds()) return;
				clearTimeout(timer);
				watchers.delete(check);
				done();
			};
			watchers.add(check);
		});
	const matches = (wanted: string | RegExp, text: string) =>
		typeof wanted === "string" ? text.includes(wanted) : wanted.test(text);
	return {
		terminal,
		output,
		type: (data) => send({ type: "input", data }),
		resize: (newRows, newColumns) => {
			terminal.resize(newColumns, newRows);
			send({ type: "resize", rows: newRows, columns: newColumns });
		},
		screen,
		shows: (wanted, ms = SHOWN_MS) =>
			until(
				() => matches(wanted, screen().join("\n")),
				() =>
					`the screen never showed ${String(wanted)}; it shows:\n${screen().join("\n")}`,
				ms,
			),
		sent: (wanted, ms = SHOWN_MS) =>
			until(
				() => matches(wanted, output.join("")),
				() => `the output never held ${JSON.stringify(String(wanted))}`,
				ms,
			),
		detached,
		edits,
		suspended,
		leave: () => {
			socket.end();
			return closed;
		},
	};
}

/** Send the attach request and answer the host's reply, handing on every frame after it. */
function attached(
	socket: Socket,
	sessionId: string,
	geometry: { rows: number; columns: number; features?: readonly string[] },
	frame: (frame: Frame) => void,
): Promise<{ readonly ok: boolean }> {
	return new Promise((done, fail) => {
		let pending = "";
		let replied = false;
		socket.on("data", (chunk) => {
			pending += String(chunk);
			for (;;) {
				const end = pending.indexOf("\n");
				if (end < 0) return;
				const line: unknown = JSON.parse(pending.slice(0, end));
				pending = pending.slice(end + 1);
				if (typeof line !== "object" || line === null) continue;
				if (replied) frame(frameOf(line));
				else {
					replied = true;
					done({ ok: Reflect.get(line, "ok") === true });
				}
			}
		});
		socket.once("error", fail);
		socket.write(
			`${JSON.stringify({ v: 1, id: "attach", op: "attach", sessionId, ...geometry })}\n`,
		);
	});
}

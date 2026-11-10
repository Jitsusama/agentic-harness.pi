/**
 * A screen as a viewer's terminal draws it: bytes written to xterm's
 * headless terminal, the rows it shows read back as text, and waits that
 * settle as each write lands rather than on a clock.
 */

import xterm from "@xterm/headless";

/** How long a wait for the screen may take before it fails, saying what was shown. */
export const SHOWN_MS = 15_000;

/** A terminal being drawn on, and what a test reads from it. */
export interface Drawn {
	/** The terminal the bytes are drawn on. */
	readonly terminal: xterm.Terminal;
	/** Every chunk drawn, in order. */
	readonly output: readonly string[];
	/** Draw what the other end wrote. */
	draw(data: string): void;
	/** The screen as it reads now: one string per row, trailing space dropped. */
	screen(): string[];
	/** Wait until the screen shows `wanted`, failing with what it shows instead. */
	shows(wanted: string | RegExp, ms?: number): Promise<void>;
	/** Wait until the output drawn so far holds `wanted`. */
	sent(wanted: string | RegExp, ms?: number): Promise<void>;
}

/** A terminal of `rows` by `columns` to draw on. */
export function drawn(rows: number, columns: number): Drawn {
	const terminal = new xterm.Terminal({
		rows,
		cols: columns,
		allowProposedApi: true,
		scrollback: 1000,
	});
	const output: string[] = [];
	const watchers = new Set<() => void>();
	const screen = () => {
		const buffer = terminal.buffer.active;
		return Array.from(
			{ length: terminal.rows },
			(_, row) =>
				buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
		);
	};
	// Checked as each write lands on the terminal, rather than polled.
	const onceItHolds = (holds: () => boolean, what: () => string, ms: number) =>
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
		draw: (data) => {
			output.push(data);
			terminal.write(data, () => {
				for (const watcher of [...watchers]) watcher();
			});
		},
		screen,
		shows: (wanted, ms = SHOWN_MS) =>
			onceItHolds(
				() => matches(wanted, screen().join("\n")),
				() =>
					`the screen never showed ${String(wanted)}; it shows:\n${screen().join("\n")}`,
				ms,
			),
		sent: (wanted, ms = SHOWN_MS) =>
			onceItHolds(
				() => matches(wanted, output.join("")),
				() => `the output never held ${JSON.stringify(String(wanted))}`,
				ms,
			),
	};
}

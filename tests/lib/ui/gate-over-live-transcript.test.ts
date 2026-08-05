/**
 * A gate stays whole while the transcript underneath it lives.
 *
 * The frame this replays is the one a screenshot caught: a long
 * transcript, a tool call appended after the last full paint, a working
 * spinner ticking, and the merge gate overlaid on top of all of it. On
 * screen the gate showed a second spinner inside its own border and one
 * row whose right half was the editor content from the frame before,
 * spliced mid-word onto the gate's own text.
 *
 * The assertions are against a real terminal emulator, not against the
 * lines the compositor believes it produced, because the defect class
 * here is exactly the gap between the two: every row can measure
 * correctly and the screen can still shear if the writer's cursor
 * arithmetic drifts while the buffer grows under an overlay.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Terminal, TUI } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { showSinglePrompt } from "../../../lib/ui/prompt-single.js";
import { wordWrap } from "../../../lib/ui/text-layout.js";
import { plainTheme } from "./fake-theme.js";

const COLUMNS = 170;
const ROWS = 45;

/** A terminal that is really xterm, so wraps and scrolls are the real ones. */
class VirtualTerminal implements Terminal {
	readonly emulator: InstanceType<typeof xterm.Terminal>;

	constructor(
		readonly columns: number,
		readonly rows: number,
	) {
		this.emulator = new xterm.Terminal({
			cols: columns,
			rows,
			disableStdin: true,
			allowProposedApi: true,
		});
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.emulator.write(data);
	}
	get kittyProtocolActive(): boolean {
		return true;
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

	/** Every pending write applied, then the screen as a person sees it. */
	async screen(): Promise<string[]> {
		await new Promise<void>((resolve) => this.emulator.write("", resolve));
		const lines: string[] = [];
		const buffer = this.emulator.buffer.active;
		for (let i = 0; i < this.rows; i++) {
			lines.push(
				buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "",
			);
		}
		return lines;
	}
}

/** The transcript as a component, mutable the way pi's own tree is. */
class LiveTranscript implements Component {
	lines: string[] = [];
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/** Let the TUI's throttled pipeline run, then settle xterm. */
async function settled(terminal: VirtualTerminal): Promise<string[]> {
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await new Promise((resolve) => setTimeout(resolve, 30));
	return terminal.screen();
}

/** The transcript before the tool ran: long enough to scroll into history. */
function backlog(): string[] {
	const rows: string[] = [];
	for (let i = 1; i <= 120; i++) {
		rows.push(`transcript line ${i}: earlier conversation and tool output`);
	}
	return rows;
}

/** The rows pi puts under the transcript while a person is typing. */
function editorRows(): string[] {
	return [
		"Fix What the PR Session Turned Up",
		"/var/folders/xb/T/pi-clipboard-14b9c8ec-433d-40b6-aa81-83ca9bb7fc4f.png",
		"/var/folders/xb/T/pi-clipboard-8f9657a2-0791-4e70-879b-bc4adb00fe98.png",
		"~/src/github.com/Jitsusama/agentic-harness.pi · main · claude-fable-5",
	];
}

const GATE_BODY = [
	"▶ Jitsusama/agentic-harness.pi#443",
	"   the repo's own merge policy",
	"   only if the head is still f18f69f6a0b5791861a854445bc2f73b15b04a5b",
].join("\n");

describe("the merge gate over a live transcript", () => {
	let stdoutRows: PropertyDescriptor | undefined;
	let stdoutColumns: PropertyDescriptor | undefined;

	beforeEach(() => {
		// The panel budget reads the process's own stdout, which in a test
		// is not the emulator. Point it at the same geometry.
		stdoutRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		stdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		Object.defineProperty(process.stdout, "rows", {
			value: ROWS,
			configurable: true,
		});
		Object.defineProperty(process.stdout, "columns", {
			value: COLUMNS,
			configurable: true,
		});
	});

	afterEach(() => {
		if (stdoutRows) Object.defineProperty(process.stdout, "rows", stdoutRows);
		if (stdoutColumns)
			Object.defineProperty(process.stdout, "columns", stdoutColumns);
	});

	it("keeps every base row out of the panel while the spinner ticks", async () => {
		const terminal = new VirtualTerminal(COLUMNS, ROWS);
		const tui = new TUI(terminal);
		const transcript = new LiveTranscript();
		tui.addChild(transcript);

		// Frame 1: the resting session. Transcript, widget, editor, status.
		transcript.lines = [...backlog(), ...editorRows()];
		tui.start();
		await settled(terminal);

		// Frame 2: the tool call lands and the spinner appears, growing the
		// buffer after the last full paint.
		transcript.lines = [
			...backlog(),
			"review_offer merge Jitsusama/agentic-harness.pi#443",
			"⠿ Working...",
			...editorRows(),
		];
		tui.requestRender();
		await settled(terminal);

		// Frame 3: the gate opens over all of it.
		const theme = plainTheme() as Theme;
		const ctx = {
			hasUI: true,
			ui: {
				custom: <T>(
					factory: (
						t: TUI,
						th: Theme,
						kb: unknown,
						done: (result: T) => void,
					) => Component,
					options?: { overlayOptions?: Parameters<TUI["showOverlay"]>[1] },
				) =>
					new Promise<T>((resolve) => {
						const component = factory(tui, theme, undefined, resolve);
						tui.showOverlay(component, options?.overlayOptions);
						tui.requestRender();
					}),
			},
		};
		// Never awaited: the gate stays open, which is the state under test.
		void showSinglePrompt(ctx as never, {
			title: "Merge Jitsusama/agentic-harness.pi#443",
			content: (_theme, width) => wordWrap(GATE_BODY, width),
			actions: [{ key: "r", label: "Reject" }],
		});
		await settled(terminal);

		// Frames 4 and 5: the spinner ticks underneath the open gate.
		for (const glyph of ["⠹", "⠸"]) {
			transcript.lines = [
				...backlog(),
				"review_offer merge Jitsusama/agentic-harness.pi#443",
				`${glyph} Working...`,
				...editorRows(),
			];
			tui.requestRender();
			await settled(terminal);
		}

		const screen = await settled(terminal);
		tui.stop();

		// The gate's own text is on screen at all.
		expect(screen.join("\n")).toContain("the repo's own merge policy");

		// No row marries gate text to base text: that splice is the defect.
		for (const row of screen) {
			if (row.includes("merge policy") || row.includes("only if the head")) {
				expect(row).not.toContain("pi-clipboard");
				expect(row).not.toContain("transcript line");
			}
		}

		// One spinner, not a ghost trail of them.
		const spinners = screen.filter((row) => row.includes("Working...")).length;
		expect(spinners).toBeLessThanOrEqual(1);

		// Inside the panel borders nothing of the base may show. The borders
		// are the full-width rules the prompt draws first and last.
		const borders = screen
			.map((row, at) => ({ row, at }))
			.filter(({ row }) => /^─+$/.test(row.trim()) && row.trim().length > 100)
			.map(({ at }) => at);
		expect(borders.length).toBeGreaterThanOrEqual(2);
		const top = borders[0] ?? 0;
		const bottom = borders[borders.length - 1] ?? screen.length - 1;
		for (let at = top + 1; at < bottom; at++) {
			const row = screen[at] ?? "";
			expect(row).not.toContain("pi-clipboard");
			expect(row).not.toContain("transcript line");
		}
	});
});

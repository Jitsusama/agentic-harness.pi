import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	hyperlink,
	ScrollView,
	type Terminal,
	Text,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerPlainPresses } from "../../../../lib/internal/links/press.ts";
import { linkAtClick } from "../../../../lib/internal/links/resolve.ts";
import type { PlaceWorld } from "../../../../lib/internal/links/targets.ts";
import { until } from "../../../support/until.ts";

const COLUMNS = 60;
const ROWS = 12;

/** A terminal that is really xterm, so a test finds a cell where a person would. */
class XtermTerminal implements Terminal {
	readonly emulator = new xterm.Terminal({
		cols: COLUMNS,
		rows: ROWS,
		allowProposedApi: true,
	});
	private onInput: ((data: string) => void) | undefined;
	readonly columns = COLUMNS;
	readonly rows = ROWS;

	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.emulator.write(data);
	}
	get kittyProtocolActive(): boolean {
		return true;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}

	/** The bytes a terminal sends for the mouse, at a 0-based cell. */
	mouse(button: number, x: number, y: number, release: boolean): void {
		this.onInput?.(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
	}

	/** A plain left click: press and release on one cell. */
	click(x: number, y: number): void {
		this.mouse(0, x, y, false);
		this.mouse(0, x, y, true);
	}

	/** Where `needle` shows, once it does. */
	async cellOf(needle: string): Promise<{ x: number; y: number }> {
		let found: { x: number; y: number } | undefined;
		await until(`${needle} on screen`, async () => {
			await new Promise<void>((resolve) => this.emulator.write("", resolve));
			const buffer = this.emulator.buffer.active;
			for (let y = 0; y < ROWS; y++) {
				const x =
					buffer.getLine(buffer.viewportY + y)?.translateToString() ?? "";
				const at = x.indexOf(needle);
				if (at >= 0) found = { x: at, y };
			}
			return found !== undefined;
		});
		if (!found) throw new Error(`${needle} never showed`);
		return found;
	}
}

let world: PlaceWorld;
let notes: string;
let opened: string[];
let terminal: XtermTerminal;
let tui: TuiAltScreen;
let release: () => void;

function show(text: string): void {
	tui.addChild(new Text(text, 1, 0));
	tui.start();
}

beforeEach(() => {
	const home = mkdtempSync(join(tmpdir(), "links-press-"));
	mkdirSync(join(home, "quests"));
	notes = join(home, "notes.md");
	writeFileSync(notes, "#");
	world = {
		home,
		questsRoot: join(home, "quests"),
		originRepo: () => undefined,
	};
	release = answerPlainPresses(
		TuiAltScreen.prototype,
		(screen, x, y, columns) => linkAtClick(screen, x, y, columns, world),
	);
	opened = [];
	terminal = new XtermTerminal();
	tui = new TuiAltScreen(terminal, false, undefined, {
		openUrl: (url) => opened.push(url),
	});
});

afterEach(() => {
	tui.stop();
	release();
});

describe("a plain click on pi's fullscreen", () => {
	it("opens a URL and a path drawn as plain text", async () => {
		show(`see https://example.com/a and ${notes} too`);
		const url = await terminal.cellOf("example");
		terminal.click(url.x, url.y);
		await until("the URL opened", () => opened.length === 1);
		const path = await terminal.cellOf("notes.md");
		terminal.click(path.x, path.y);
		await until("the path opened", () => opened.length === 2);
		expect(opened).toEqual([
			"https://example.com/a",
			pathToFileURL(notes).href,
		]);
	});

	it("leaves a link pi drew as OSC 8 to pi", async () => {
		show(`read ${hyperlink("the docs", "https://example.com/docs")}`);
		const link = await terminal.cellOf("docs");
		terminal.click(link.x, link.y);
		await until("the link opened", () => opened.length === 1);
		expect(opened).toEqual(["https://example.com/docs"]);
	});

	it("leaves a click on the prompt being typed to the prompt", async () => {
		// pi's fullscreen: the transcript scrolls, the dock under it does not.
		const transcript = new ScrollView(
			new Text("said https://example.com/said", 1, 0),
			{ primary: true },
		);
		const prompt = new Text("typing https://example.com/typed", 1, 0);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: prompt, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]),
		);
		tui.start();
		const typed = await terminal.cellOf("example.com/typed");
		terminal.click(typed.x, typed.y);
		const said = await terminal.cellOf("example.com/said");
		terminal.click(said.x, said.y);
		await until("the last click opened", () => opened.length > 0);
		expect(opened).toEqual(["https://example.com/said"]);
	});

	it("leaves a click to an open overlay", async () => {
		show("see https://example.com/under");
		const picker = tui.showOverlay(new Text("a picker", 1, 0), {
			anchor: "bottom-center",
			width: 20,
		});
		await terminal.cellOf("a picker");
		const under = await terminal.cellOf("example.com/under");
		terminal.click(under.x, under.y);
		picker.hide();
		await until("the picker gone", async () => {
			await new Promise<void>((resolve) =>
				terminal.emulator.write("", resolve),
			);
			const buffer = terminal.emulator.buffer.active;
			for (let y = 0; y < ROWS; y++) {
				const row = buffer.getLine(buffer.viewportY + y)?.translateToString();
				if (row?.includes("a picker")) return false;
			}
			return true;
		});
		expect(opened).toEqual([]);
		terminal.click(under.x, under.y);
		await until("the click opened", () => opened.length > 0);
		expect(opened).toEqual(["https://example.com/under"]);
	});

	it("opens nothing for a drag, a right click or a plain word", async () => {
		show("words https://example.com/a");
		const word = await terminal.cellOf("words");
		const url = await terminal.cellOf("example");
		terminal.mouse(0, url.x, url.y, false);
		terminal.mouse(32, url.x + 3, url.y, false);
		terminal.mouse(0, url.x + 3, url.y, true);
		terminal.mouse(2, url.x, url.y, false);
		terminal.mouse(2, url.x, url.y, true);
		terminal.click(word.x, word.y);
		terminal.click(url.x, url.y);
		await until("the last click opened", () => opened.length > 0);
		expect(opened).toEqual(["https://example.com/a"]);
	});
});

describe("the wrap of pi's press", () => {
	it("wraps once however often it is installed, and comes off", () => {
		const method = Reflect.get(
			TuiAltScreen.prototype,
			"handleSelectionMouseEvent",
		);
		const again = answerPlainPresses(TuiAltScreen.prototype, () => undefined);
		expect(
			Reflect.get(TuiAltScreen.prototype, "handleSelectionMouseEvent"),
		).toBe(method);
		again();
		release();
		expect(
			Reflect.get(TuiAltScreen.prototype, "handleSelectionMouseEvent"),
		).not.toBe(method);
		release = answerPlainPresses(TuiAltScreen.prototype, () => undefined);
	});

	it("does nothing where pi's press is not the shape it knows", () => {
		const prototype = {};
		answerPlainPresses(prototype, () => "https://example.com")();
		expect(Reflect.ownKeys(prototype)).toEqual([]);

		const seen: unknown[] = [];
		const shaped = {
			handleSelectionMouseEvent(event: unknown) {
				seen.push(event);
				return "pi's own";
			},
		};
		const off = answerPlainPresses(shaped, () => "https://example.com");
		const strange = { previousScreen: "not rows" };
		const event = { button: 0, x: 0, y: 0, release: false };
		expect(shaped.handleSelectionMouseEvent.call(strange, event)).toBe(
			"pi's own",
		);
		expect(strange).toEqual({ previousScreen: "not rows" });
		expect(seen).toEqual([event]);
		off();
	});

	it("keeps pi's own press when the answer throws", async () => {
		release();
		release = answerPlainPresses(TuiAltScreen.prototype, () => {
			throw new Error("broken");
		});
		show(`read ${hyperlink("the docs", "https://example.com/docs")} or plain`);
		const plain = await terminal.cellOf("plain");
		terminal.click(plain.x, plain.y);
		const link = await terminal.cellOf("docs");
		terminal.click(link.x, link.y);
		await until("the link opened", () => opened.length === 1);
		expect(opened).toEqual(["https://example.com/docs"]);
	});
});

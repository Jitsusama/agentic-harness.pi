/**
 * A real screen with pi's own way of mounting a panel on it.
 *
 * The terminal is xterm, so what a test reads back is what a person
 * would see, not what the compositor believes it drew. The TUI is pi's.
 * `custom` is pi 0.87.1's `showExtensionCustom` overlay path, restated
 * from the shipped bundle (`dist/bundle/chunks/chunk-NMYZN7JL.js`),
 * because the defects these tests pin live in exactly that code: its
 * close hides the topmost overlay rather than its own, and it hands the
 * overlay's handle out only after the factory's promise settles.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type Terminal,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { plainTheme } from "./fake-theme.ts";

/** A terminal that is really xterm, so wraps and scrolls are the real ones. */
export class VirtualTerminal implements Terminal {
	readonly emulator: InstanceType<typeof xterm.Terminal>;
	private onInput: ((data: string) => void) | undefined;

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

	/** Type as a person would: the bytes go in where the keyboard's do. */
	press(data: string): void {
		this.onInput?.(data);
	}

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

/** A component that is just some lines. */
export class Lines implements Component {
	constructor(public lines: string[]) {}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

type Factory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: unknown,
	done: (result: T) => void,
) => Component | Promise<Component>;

interface CustomOptions {
	overlay?: boolean;
	overlayOptions?: OverlayOptions | (() => OverlayOptions);
	onHandle?: (handle: OverlayHandle) => void;
}

/** Things a test can do inside pi's mount, where nothing else can reach. */
export interface MountHooks {
	/** Runs once the factory has built the panel, before pi shows it. */
	beforeShow?: () => void;
}

/** A running screen, and a context whose `ui.custom` is pi's. */
export interface PiScreen {
	terminal: VirtualTerminal;
	tui: TuiMainScreen;
	status: Array<string | undefined>;
	hooks: MountHooks;
	ctx(signal?: AbortSignal): ExtensionContext;
	/** Pending renders flushed, then the screen as a person sees it. */
	settled(): Promise<string>;
	stop(): void;
}

/** Start a screen with a transcript under it. */
export function piScreen(columns = 120, rows = 30): PiScreen {
	const terminal = new VirtualTerminal(columns, rows);
	const tui = new TuiMainScreen(terminal);
	tui.addChild(new Lines(["transcript line 1", "transcript line 2"]));
	tui.start();
	const theme = plainTheme() as Theme;
	const status: Array<string | undefined> = [];
	const hooks: MountHooks = {};

	// pi 0.87.1, showExtensionCustom, the overlay branch.
	function custom<T>(factory: Factory<T>, options?: CustomOptions) {
		if (!options?.overlay) throw new Error("only the overlay path is here");
		return new Promise<T>((resolve, reject) => {
			let component: (Component & { dispose?(): void }) | undefined;
			let closed = false;
			const close = (result: T) => {
				if (!closed) {
					closed = true;
					tui.hideOverlay();
					resolve(result);
					try {
						component?.dispose?.();
					} catch {
						// pi swallows a throwing dispose here too.
					}
				}
			};
			Promise.resolve(factory(tui, theme, undefined, close))
				.then((c) => {
					hooks.beforeShow?.();
					if (!closed) {
						component = c;
						const overlayOptions =
							typeof options.overlayOptions === "function"
								? options.overlayOptions()
								: options.overlayOptions;
						const handle = tui.showOverlay(component, overlayOptions);
						options.onHandle?.(handle);
					}
				})
				.catch((err: unknown) => {
					if (!closed) reject(err);
				});
		});
	}

	return {
		terminal,
		tui,
		status,
		hooks,
		ctx(signal) {
			return {
				hasUI: true,
				signal,
				ui: {
					custom,
					setStatus: (_key: string, text: string | undefined) => {
						status.push(text);
					},
				},
			} as unknown as ExtensionContext;
		},
		async settled() {
			await new Promise<void>((resolve) => process.nextTick(resolve));
			await new Promise((resolve) => setTimeout(resolve, 30));
			return (await terminal.screen()).join("\n");
		},
		stop() {
			tui.stop();
		},
	};
}

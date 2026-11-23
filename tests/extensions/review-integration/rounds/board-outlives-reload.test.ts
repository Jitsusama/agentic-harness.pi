/**
 * A round's board when its session reloads under it.
 *
 * A council waits its turn to start, sometimes for half an hour, and
 * the session that asked may reload meanwhile. Pi then makes every
 * field of the context the call was given throw. On 22 November two
 * councils opened, asked nobody and never settled, because the
 * board's first draw read that context. The board is a view of the
 * round, so a context gone stale takes the board and nothing else.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { watchRound } from "../../../../extensions/review-integration/progress.ts";
import { DOCK_NAME } from "../../../../lib/ui/gate/screen-gates.ts";

/** How many widgets the screen's dock still holds, as every load reads it. */
function docked(): number {
	const shared: unknown = Reflect.get(globalThis, Symbol.for(DOCK_NAME));
	const entries: unknown =
		typeof shared === "object" && shared !== null
			? Reflect.get(shared, "entries")
			: undefined;
	return Array.isArray(entries) ? entries.length : 0;
}

/** What pi says when a captured context is used after a reload. */
const STALE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.reload().";

/** Enough of pi's TUI for a widget to be mounted and taken down. */
const tui = {
	children: [],
	terminal: { rows: 24, columns: 80 },
	requestRender() {},
	setFocus() {},
} as unknown as TUI;

/**
 * A terminal context that mounts widgets until `reload` is called, and
 * from then on throws on every field, as pi's does. Pi's order on a
 * reload is not read here, so `reload` may clear the widgets first, as
 * the dock says pi does, or leave them.
 */
function reloadable(): {
	ctx: ExtensionContext;
	reload(options?: { disposing: boolean }): void;
} {
	let stale = false;
	const mounted: { dispose?: () => void }[] = [];
	const live = {
		hasUI: true,
		mode: "tui",
		ui: {
			theme: {
				fg: (_role: string, text: string) => text,
				bold: (text: string) => text,
				dim: (text: string) => text,
			},
			setWidget: (_key: string, factory: unknown) => {
				if (typeof factory === "function") mounted.push(factory(tui, {}));
			},
			onTerminalInput: () => () => {},
		},
	};
	const ctx = new Proxy(live, {
		get(target, field, receiver) {
			if (stale) throw new Error(STALE);
			return Reflect.get(target, field, receiver);
		},
	}) as unknown as ExtensionContext;
	return {
		ctx,
		reload: (options) => {
			if (options?.disposing === true) {
				for (const widget of mounted) widget.dispose?.();
			}
			stale = true;
		},
	};
}

const PARTICIPANTS = [
	{ id: "correctness-and-tests", model: "anthropic/claude-opus-5" },
	{ id: "test-skeptic", model: "anthropic/claude-opus-5" },
];

describe("a round's board after its session reloads", () => {
	it("still takes the round's start when the reload came first", () => {
		const { ctx, reload } = reloadable();
		const watch = watchRound("council", ctx);
		reload();

		expect(
			() => watch.progress.start(PARTICIPANTS),
			"the board's first draw does not throw on a stale context",
		).not.toThrow();
		watch.progress.started("test-skeptic");
		expect(
			watch.entries().map((one) => one.state),
			"the round is still followed without a board",
		).toEqual(["pending", "running"]);
		expect(() => watch.close(), "closing it does not throw").not.toThrow();
	});

	for (const disposing of [false, true]) {
		it(`comes down quietly when the reload came mid-round, ${disposing ? "clearing" : "leaving"} the widget`, () => {
			const before = docked();
			const { ctx, reload } = reloadable();
			const watch = watchRound("council", ctx);
			watch.progress.start(PARTICIPANTS);
			expect(docked(), "the board is docked").toBe(before + 1);
			reload({ disposing });

			watch.progress.answered("correctness-and-tests");
			expect(
				() => watch.close(),
				"taking a board down from a replaced session does not throw",
			).not.toThrow();
			expect(docked(), "and the dock no longer holds it").toBe(before);
		});
	}

	it("still throws a fault that is not a reload", () => {
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: {
				get theme(): never {
					throw new Error("the theme is broken");
				},
			},
		} as unknown as ExtensionContext;
		const watch = watchRound("council", ctx);

		expect(
			() => watch.progress.start(PARTICIPANTS),
			"only a stale context is passed over",
		).toThrow("the theme is broken");
	});
});

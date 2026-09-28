/**
 * Whether the dock mounts, by what the context says about its terminal.
 *
 * The package's peer range for pi is open, and a consumer can run a pi
 * whose context predates `mode`. There `hasUI` was already false for
 * everything but the terminal, so a dock that insisted on `mode` never
 * mounted at all: every progress board vanished rather than drawing.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { dock } from "../../../lib/ui/dock.ts";

/** Enough of pi's TUI for a widget to be mounted and taken down. */
const tui = {
	children: [],
	terminal: { rows: 24, columns: 80 },
	requestRender() {},
	setFocus() {},
} as unknown as TUI;

/** A context whose UI mounts a widget the way pi's terminal does. */
function contextWith(fields: Record<string, unknown>): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			theme: {},
			setWidget: (_key: string, factory: unknown) => {
				if (typeof factory === "function") factory(tui, {});
			},
			onTerminalInput: () => () => {},
		},
		...fields,
	} as unknown as ExtensionContext;
}

const body = { render: () => ["a row"] };

describe("the dock", () => {
	it.each([
		["a terminal", { mode: "tui" }, false],
		["a pi that predates mode", {}, false],
		["rpc", { mode: "rpc" }, true],
		["no UI", { hasUI: false, mode: "tui" }, true],
	])("on %s mounts unless inert", (_name, fields, inert) => {
		const docked = dock(contextWith(fields), "dock-mode-test", body);

		expect(docked.gone).toBe(inert);
		docked.close();
	});
});

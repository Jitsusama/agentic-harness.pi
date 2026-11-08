/**
 * The widget's wiring: still from a session's start in a terminal, pi's
 * own spinner back when it ends, and nothing at all where pi draws to
 * no terminal.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import workingSpinnerWidget from "../../../extensions/working-spinner-widget/index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

function loaded(fields: Record<string, unknown>) {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	};
	workingSpinnerWidget(pi as unknown as ExtensionAPI);
	const set: string[] = [];
	let listening = 0;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			onTerminalInput: () => {
				listening += 1;
				return () => {
					listening -= 1;
				};
			},
			setWorkingIndicator: (options?: { frames?: string[] }) =>
				set.push(options === undefined ? "spinner" : "still"),
			theme: { fg: (_color: string, text: string) => text },
		},
		...fields,
	};
	const fire = (name: string) => handlers.get(name)?.({ type: name }, ctx);
	return { fire, set, listening: () => listening };
}

describe("the working spinner widget", () => {
	it("holds the spinner still for a session's life, listening once", async () => {
		const { fire, set, listening } = loaded({});
		await fire("session_start");
		await fire("session_start");
		const during = listening();
		await fire("session_shutdown");
		expect({ set, during, after: listening() }).toEqual({
			set: ["still", "spinner", "still", "spinner"],
			during: 1,
			after: 0,
		});
	});

	it("leaves a pi that draws to no terminal alone", async () => {
		const { fire, set, listening } = loaded({ mode: "rpc" });
		await fire("session_start");
		expect({ set, listening: listening() }).toEqual({ set: [], listening: 0 });
	});
});

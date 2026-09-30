/**
 * A provider registers over the bus whichever of it and the host loads
 * first, and the focus it is handed says each instruction once.
 */

import { describe, expect, it } from "vitest";
import {
	COMPACTION_READY,
	COMPACTION_REGISTER_PROVIDER,
	type CompactionProvider,
	combinedFocus,
	isCompactionProvider,
	registerCompactionProvider,
} from "../../../lib/compaction/index.ts";

function bus() {
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	return {
		on(channel: string, handler: (data: unknown) => void) {
			listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
			return () =>
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((h) => h !== handler),
				);
		},
		emit(channel: string, data: unknown) {
			for (const handler of listeners.get(channel) ?? []) handler(data);
		},
	};
}

const provider: CompactionProvider = {
	id: "selection",
	precedence: 200,
	followsFocus: false,
	assess: () => ({ ok: false, reason: "no classifier" }),
	write: async () => ({ ok: false, reason: "no classifier" }),
};

describe("registering a compaction provider", () => {
	it("registers at once and again each time the host announces itself, until stopped", () => {
		const events = bus();
		const seen: unknown[] = [];
		events.on(COMPACTION_REGISTER_PROVIDER, (data) => seen.push(data));

		const stop = registerCompactionProvider(events, provider);
		events.emit(COMPACTION_READY, {});
		stop();
		events.emit(COMPACTION_READY, {});

		expect(seen).toEqual([provider, provider]);
	});

	it("recognises a provider on the bus and nothing short of one", () => {
		expect(isCompactionProvider(provider)).toBe(true);
		expect(isCompactionProvider({ ...provider, id: "" })).toBe(false);
		expect(isCompactionProvider({ ...provider, write: "later" })).toBe(false);
		expect(isCompactionProvider(null)).toBe(false);
	});
});

describe("the combined focus", () => {
	it("says a focus typed and contributed once, and nothing when there is none", () => {
		expect(
			combinedFocus({
				requested: "keep the layer",
				contributed: ["keep the layer", "  ", "name the tree"],
			}),
		).toBe("keep the layer\n\nname the tree");
		expect(combinedFocus({ requested: " ", contributed: [] })).toBeUndefined();
	});
});

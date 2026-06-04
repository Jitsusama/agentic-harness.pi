import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getQuestPrBridge,
	type QuestPrBridge,
	registerQuestPrBridge,
	unregisterQuestPrBridge,
} from "../../../lib/quest/pr-bridge";

function makeBridge(label: string): QuestPrBridge {
	return {
		questsRoot: () => `/root/${label}`,
		loadedQuestId: () => null,
		logJourney: () => {
			/* no-op */
		},
	};
}

beforeEach(() => {
	unregisterQuestPrBridge();
});

afterEach(() => {
	unregisterQuestPrBridge();
});

describe("registerQuestPrBridge", () => {
	it("overwrites any prior registration", () => {
		const a = makeBridge("a");
		const b = makeBridge("b");
		registerQuestPrBridge(a);
		registerQuestPrBridge(b);
		expect(getQuestPrBridge()).toBe(b);
	});
});

describe("unregisterQuestPrBridge", () => {
	it("clears the slot when called with no argument", () => {
		registerQuestPrBridge(makeBridge("a"));
		unregisterQuestPrBridge();
		expect(getQuestPrBridge()).toBeUndefined();
	});

	it("clears the slot when passed the currently registered bridge", () => {
		const a = makeBridge("a");
		registerQuestPrBridge(a);
		unregisterQuestPrBridge(a);
		expect(getQuestPrBridge()).toBeUndefined();
	});

	it("leaves a fresher bridge in place when an old instance shuts down", () => {
		const a = makeBridge("a");
		const b = makeBridge("b");
		registerQuestPrBridge(a);
		registerQuestPrBridge(b);
		// An out-of-order shutdown from instance `a` should
		// not clobber `b`. This is the scenario the council
		// flagged: a stale activation's session_shutdown
		// firing after a newer activation has already
		// installed its bridge.
		unregisterQuestPrBridge(a);
		expect(getQuestPrBridge()).toBe(b);
	});
});

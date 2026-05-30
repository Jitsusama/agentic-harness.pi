/**
 * Pi wipes in-memory state on `/reload`. These tests assert
 * what survives that reload by round-tripping through the
 * persist/restore API with stub pi objects. The wire format is
 * an implementation detail; the tests work in terms of the loop
 * state that comes back.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	persist,
	restore,
} from "../../../extensions/tdd-workflow/lifecycle.js";
import { initialState } from "../../../extensions/tdd-workflow/machine.js";
import { createTddState } from "../../../extensions/tdd-workflow/state.js";

interface Entry {
	type: string;
	customType?: string;
	data?: unknown;
}

function makeApi(entries: Entry[]): ExtensionAPI {
	return {
		appendEntry(name: string, data: unknown) {
			entries.push({ type: "custom", customType: name, data });
		},
	} as unknown as ExtensionAPI;
}

function makeCtx(entries: Entry[]): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => entries,
		},
	} as unknown as ExtensionContext;
}

describe("tdd-workflow lifecycle", () => {
	it("restores the initial state when nothing has been persisted", () => {
		const state = createTddState();
		restore(state, makeCtx([]));
		expect(state.loop).toEqual(initialState());
	});

	it("round-trips an active loop through persist and restore", () => {
		const entries: Entry[] = [];
		const source = createTddState();
		source.loop = {
			phase: "red",
			assertionFailure: true,
			behaviour: "rejects an empty cart",
			iteration: 3,
		};

		persist(source, makeApi(entries));

		const restored = createTddState();
		restore(restored, makeCtx(entries));
		expect(restored.loop).toEqual(source.loop);
	});

	it("ignores a legacy gated entry that predates the loop shape", () => {
		const entries: Entry[] = [
			{
				type: "custom",
				customType: "tdd-workflow",
				data: { enabled: true, phase: "red", cycle: 2 },
			},
		];
		const state = createTddState();
		restore(state, makeCtx(entries));
		expect(state.loop).toEqual(initialState());
	});

	it("preserves a live loop entry that is missing a later field", () => {
		const entries: Entry[] = [
			{
				type: "custom",
				customType: "tdd-workflow",
				data: {
					phase: "red",
					behaviour: "rejects an empty cart",
					iteration: 2,
				},
			},
		];
		const state = createTddState();
		restore(state, makeCtx(entries));
		expect(state.loop).toEqual({
			phase: "red",
			assertionFailure: false,
			behaviour: "rejects an empty cart",
			iteration: 2,
		});
	});
});

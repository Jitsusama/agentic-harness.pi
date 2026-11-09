/** Wants, initial words and model carry survive only within their conversation. */
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSession } from "../../../../lib/core/session/index.ts";
import {
	carryModel,
	forgetAuth,
	NO_PROVIDER,
	rememberAuth,
	rememberedAuth,
	takeCarriedModel,
} from "../../../../lib/internal/session/carried-model.ts";
import {
	FIRST_PROMPT_MS,
	firstPromptPending,
	noteFirstPrompt,
	runStarted,
} from "../../../../lib/internal/session/first-prompt.ts";
import {
	forgetWants,
	onWants,
	ownWants,
	sessionWants,
	showWants,
	type WantEvent,
	wantsShown,
} from "../../../../lib/internal/session/wants.ts";
import { installTestHost } from "../../../support/session-host.ts";

let installed: ReturnType<typeof installTestHost>;
beforeEach(() => {
	installed = installTestHost();
});
afterEach(() => {
	installed.dispose();
	vi.useRealTimers();
});

function hear(id: string) {
	const bus = createEventBus();
	const heard: WantEvent[] = [];
	onWants(bus, (want) => heard.push(want));
	withSession(id, () => sessionWants().bind(bus));
	return heard;
}

describe("hosted wants", () => {
	it("raises only on A's bus, and B's bound wants survive A's close", async () => {
		const a = hear("a");
		const b = hear("b");
		withSession("a", () => sessionWants().raise("question", "A question"));
		expect(a.map((w) => w.said)).toEqual(["A question"]);
		expect(b).toEqual([]);
		withSession("b", () => sessionWants().raise("approval", "B approval"));
		await installed.host.close("a", "done");
		withSession("b", () => sessionWants().end("approval"));
		expect(b.map((w) => w.said)).toEqual(["B approval", null]);
	});

	it("keeps the same owner name apart in A and B, including A's shutdown", async () => {
		const a = hear("a");
		const b = hear("b");
		withSession("a", () => ownWants("away").say("blocked", "A blocked"));
		expect(b).toEqual([]);
		withSession("b", () => ownWants("away").say("blocked", "B blocked"));
		withSession("a", () => ownWants("away").settle("blocked"));
		expect(a.map((w) => w.said)).toEqual(["A blocked", null]);
		expect(b.map((w) => w.said)).toEqual(["B blocked"]);
		await installed.host.close("a", "done");
		withSession("b", () => ownWants("away").settle("blocked"));
		expect(b.map((w) => w.said)).toEqual(["B blocked", null]);
	});

	it("shows wants only for the showing session, with a disposer bound to it", async () => {
		const hideA = withSession("a", showWants);
		expect(
			withSession("b", wantsShown),
			"A showing its wants does not show B's",
		).toBe(false);
		const hideB = withSession("b", showWants);
		// A's disposer can be called without ambient context.
		hideA();
		await installed.host.close("a", "done");
		expect(
			withSession("b", wantsShown),
			"B's wants stay shown when A hides its own and closes",
		).toBe(true);
		hideB();
		expect(
			withSession("b", wantsShown),
			"B's own disposer hides B's wants",
		).toBe(false);
	});

	it("forgets A without clearing B or letting stale disposers hide a new showing", () => {
		hear("a");
		const b = hear("b");
		withSession("b", () => ownWants("same").say("blocked", "B blocked"));
		const stale = withSession("a", showWants);
		withSession("a", forgetWants);
		const current = withSession("a", showWants);
		stale();
		expect(
			withSession("a", wantsShown),
			"a stale disposer does not hide A's new showing",
		).toBe(true);
		current();
		withSession("b", () => ownWants("same").settle("blocked"));
		expect(b.map((w) => w.said)).toEqual(["B blocked", null]);
	});
});

describe("hosted first prompt", () => {
	it("knows admitted words, not host argv or host uptime, until that session runs", async () => {
		withSession("a", () => noteFirstPrompt("A words"));
		withSession("b", () => noteFirstPrompt("B words"));
		expect(
			withSession("a", () => firstPromptPending([], FIRST_PROMPT_MS + 1)),
			"A's admitted words are pending past the host's uptime",
		).toBe(true);
		withSession("a", runStarted);
		expect(
			withSession("a", firstPromptPending),
			"A's words are no longer pending once A runs",
		).toBe(false);
		expect(
			withSession("b", firstPromptPending),
			"B's words stay pending when A runs",
		).toBe(true);
		await installed.host.close("a", "done");
		expect(
			withSession("b", firstPromptPending),
			"B's words stay pending when A closes",
		).toBe(true);
	});

	it("has no pending words when admission says none, even when the host has CLI words", () => {
		withSession("a", () => noteFirstPrompt("A words"));
		withSession("b", () => noteFirstPrompt(undefined));
		expect(
			withSession("b", () => firstPromptPending(["Host words"], 1)),
			"B admitted with no words has none pending, whatever the host's argv",
		).toBe(false);
	});

	it("expires from the conversation's admission time, including one opened long after boot", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		withSession("a", () => noteFirstPrompt("A words"));
		vi.setSystemTime(1_000_000 + FIRST_PROMPT_MS - 1);
		withSession("b", () => noteFirstPrompt("B words"));
		expect(
			withSession("a", firstPromptPending),
			"A's words are pending until FIRST_PROMPT_MS after A's admission",
		).toBe(true);
		vi.advanceTimersByTime(1);
		expect(
			withSession("a", firstPromptPending),
			"A's words expire FIRST_PROMPT_MS after A's admission",
		).toBe(false);
		expect(
			withSession("b", firstPromptPending),
			"B, admitted later, keeps its words pending",
		).toBe(true);
	});
});

const carried = {
	path: "/same-log",
	provider: "provider",
	modelId: "model-a",
	thinkingLevel: "high" as const,
};

describe("hosted model carry", () => {
	it("lets only the carrying conversation take its model and preserves B after A closes", async () => {
		withSession("a", () => carryModel(carried));
		expect(
			withSession("b", () => takeCarriedModel(carried.path)),
		).toBeUndefined();
		withSession("b", () => carryModel({ ...carried, modelId: "model-b" }));
		expect(withSession("a", () => takeCarriedModel(carried.path))).toEqual(
			carried,
		);
		await installed.host.close("a", "done");
		expect(
			withSession("b", () => takeCarriedModel(carried.path))?.modelId,
		).toBe("model-b");
	});

	it("clears only A's model when it has no provider", () => {
		for (const id of ["a", "b"]) withSession(id, () => carryModel(carried));
		withSession("a", () => carryModel({ ...carried, provider: NO_PROVIDER }));
		expect(
			withSession("a", () => takeCarriedModel(carried.path)),
		).toBeUndefined();
		expect(withSession("b", () => takeCarriedModel(carried.path))).toEqual(
			carried,
		);
	});

	it("keeps provider auth scoped to the remembering conversation after A forgets and closes", async () => {
		withSession("a", () => rememberAuth("same", { variables: { KEY: "a" } }));
		expect(withSession("b", () => rememberedAuth("same"))).toBeUndefined();
		withSession("b", () => rememberAuth("same", { variables: { KEY: "b" } }));
		withSession("a", forgetAuth);
		await installed.host.close("a", "done");
		expect(withSession("b", () => rememberedAuth("same"))?.variables).toEqual({
			KEY: "b",
		});
	});
});

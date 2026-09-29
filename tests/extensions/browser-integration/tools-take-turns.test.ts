/**
 * Every browser tool runs in its session's turn and answers a stop.
 *
 * Ordinarily extension wiring is left to live driving, but these
 * behaviours are invisible there until they go wrong: a tool that
 * forgets its signal still works, right up until Escape does nothing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserSession } from "@jitsusama/agentic-harness.core/web/session";
import { describe, expect, it } from "vitest";
import { registerCheck } from "../../../extensions/browser-integration/check.ts";
import { registerDo } from "../../../extensions/browser-integration/do.ts";
import { registerGo } from "../../../extensions/browser-integration/go.ts";
import {
	createSessionRegistry,
	DEFAULT_SESSION,
} from "../../../extensions/browser-integration/registry.ts";
import { registerSee } from "../../../extensions/browser-integration/see.ts";

/** Long enough that a call nothing held back would plainly have run. */
const SETTLED_WITHIN_MS = 200;

type Execute = (
	id: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<unknown>;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A session on a real-looking page whose every operation hangs until
 * the test says, recording what was asked of it.
 */
function hangingSession() {
	const asked: string[] = [];
	let answer: () => void = () => undefined;
	const answered = new Promise<void>((resolve) => {
		answer = resolve;
	});
	const known: Record<string, unknown> = {
		url: "https://example.com/",
		lastUsedAt: Date.now(),
		close: async () => undefined,
		// Not a thenable, or opening it would try to await it.
		// biome-ignore lint/suspicious/noThenProperty: see above
		then: undefined,
	};
	const session = new Proxy(known, {
		get(target, property) {
			if (typeof property !== "string") return undefined;
			if (property in target) return target[property];
			return () => {
				asked.push(property);
				return answered.then(() => {
					throw new Error("the page went away");
				});
			};
		},
	}) as unknown as BrowserSession;
	return { session, asked, answer };
}

/** The four tools over one open session. */
async function tools() {
	const page = hangingSession();
	const registry = createSessionRegistry({ open: async () => page.session });
	await registry.acquire(DEFAULT_SESSION);
	const registered = new Map<string, Execute>();
	const pi = {
		registerTool(tool: { name: string; execute: Execute }) {
			registered.set(tool.name, tool.execute);
		},
	} as unknown as ExtensionAPI;
	registerGo(pi, registry);
	registerSee(pi, registry);
	registerDo(pi, registry);
	registerCheck(pi, registry);
	const tool = (name: string): Execute => {
		const execute = registered.get(name);
		if (!execute) throw new Error(`${name} was not registered`);
		return execute;
	};
	return { tool, page };
}

/** Whatever the call answered within the window, or that it had not. */
function within(call: Promise<unknown>) {
	return Promise.race([
		call.catch((error: Error) => error),
		pause(SETTLED_WITHIN_MS).then(() => "still running"),
	]);
}

describe("a browser tool", () => {
	it.each([
		["browser_go", { url: "https://example.com/next" }],
		["browser_see", { kind: "vitals" }],
		["browser_do", { kind: "wait", ms: 5_000 }],
		["browser_check", { kind: "keyboard" }],
	])("%s answers a stop at once", async (name, params) => {
		const { tool, page } = await tools();
		const stop = new AbortController();

		const call = tool(name)("call", params, stop.signal);
		await pause(1);
		const askedBeforeStop = page.asked.length;
		stop.abort();
		const answered = await within(call);
		page.answer();

		expect(askedBeforeStop).toBeGreaterThan(0);
		expect(answered).toMatchObject({ name: "AbortError" });
	});

	// A stopped call still holds its session until the browser finishes
	// what it was asked, so how long it may be asked for is what bounds the
	// wait of the call behind it.
	it.each([
		[
			"browser_do",
			{ kind: "wait", for: "text", text: "x", timeoutMs: 600_000 },
		],
		["browser_do", { kind: "wait", ms: 600_000 }],
		[
			"browser_do",
			{ kind: "input", gesture: "longPress", x: 1, y: 1, holdMs: 600_000 },
		],
		["browser_see", { kind: "profile", ms: 600_000 }],
		["browser_check", { kind: "keyboard", maxStops: 1_000_000 }],
	])("%s refuses an unbounded ask before touching the page (%j)", async (name, params) => {
		const { tool, page } = await tools();

		const answered = await within(tool(name)("call", params));
		page.answer();

		expect(answered).toMatchObject({
			content: [{ text: expect.stringMatching(/at most/) }],
		});
		expect(page.asked).toEqual([]);
	});

	it("waits for another call on the same session to finish", async () => {
		const { tool, page } = await tools();

		const first = tool("browser_see")("one", { kind: "vitals" });
		const second = tool("browser_see")("two", { kind: "vitals" });
		await pause(SETTLED_WITHIN_MS);
		const askedWhileFirstRan = [...page.asked];
		page.answer();
		await Promise.allSettled([first, second]);

		expect(askedWhileFirstRan).toEqual(["vitals"]);
		expect(page.asked).toEqual(["vitals", "vitals"]);
	});
});

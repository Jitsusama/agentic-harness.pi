/** A screen's start, timed in parts: pi's init steps and each extension's handlers, said in one line. */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	type StartParts,
	startLine,
	timeStart,
} from "../../../host/screen/start-parts.ts";

/** A clock a test moves by hand. */
function clock() {
	let at = 0;
	return {
		now: () => at,
		pass: (ms: number) => {
			at += ms;
		},
	};
}

type Handler = (...args: unknown[]) => unknown;

/** pi's runner as a runtime holds it, with one extension's handlers by event. */
function runtimeWith(
	extensions: { path: string; handlers: Map<string, Handler[]> }[],
) {
	return { session: { extensionRunner: { extensions } } };
}

/** A mode whose init runs pi's steps in its order, each taking the time given. */
function modeWith(
	time: ReturnType<typeof clock>,
	runtime: ReturnType<typeof runtimeWith>,
) {
	const emit = async (event: string) => {
		for (const extension of runtime.session.extensionRunner.extensions)
			for (const handler of [...(extension.handlers.get(event) ?? [])])
				await handler(event);
	};
	const mode = {
		themeController: {
			waitForTerminalColors: async () => time.pass(100),
		},
		async rebindCurrentSession() {
			time.pass(200);
			await emit("session_start");
			await mode.updateAvailableProviderCount();
		},
		renderInitialMessages() {
			time.pass(300);
		},
		async updateAvailableProviderCount() {
			time.pass(40);
		},
		async init() {
			await mode.themeController.waitForTerminalColors();
			// What pi does with no step to wrap: finding fd and rg.
			time.pass(500);
			await mode.rebindCurrentSession();
			mode.renderInitialMessages();
			await mode.updateAvailableProviderCount();
		},
	};
	return mode;
}

function partsOf(parts: StartParts) {
	return Object.fromEntries(parts.steps.map(({ name, ms }) => [name, ms]));
}

describe("a screen's start parts", () => {
	it("times each init step, counting a step's own call to another in it", async () => {
		const time = clock();
		const runtime = runtimeWith([]);
		const mode = modeWith(time, runtime);
		const parts = await timeStart(mode, runtime, () => mode.init(), time.now);
		expect(parts.ms).toBe(1180);
		expect(partsOf(parts)).toEqual({
			colours: 100,
			bind: 240,
			draw: 300,
			providers: 40,
		});
	});

	it("times each extension's handlers by its folder, slowest first", async () => {
		const time = clock();
		const slow: Handler = async () => time.pass(700);
		const quick: Handler = () => time.pass(20);
		const runtime = runtimeWith([
			{
				path: "/pkg/extensions/quick-widget/index.ts",
				handlers: new Map([["session_start", [quick]]]),
			},
			{
				path: "/pkg/extensions/slow-workflow/index.ts",
				handlers: new Map([["session_start", [slow, quick]]]),
			},
			{
				path: "/home/me/.pi/agent/extensions/lone.ts",
				handlers: new Map([["session_start", [() => time.pass(5)]]]),
			},
		]);
		const mode = modeWith(time, runtime);
		const parts = await timeStart(mode, runtime, () => mode.init(), time.now);
		expect(parts.extensions).toEqual([
			{ name: "slow-workflow", ms: 720 },
			{ name: "quick-widget", ms: 20 },
			{ name: "lone.ts", ms: 5 },
		]);
		expect(partsOf(parts).bind).toBe(985);
	});

	it("puts every method and handler back once the start settles", async () => {
		const time = clock();
		const handler: Handler = () => undefined;
		const list = [handler];
		const runtime = runtimeWith([
			{ path: "/x/index.ts", handlers: new Map([["session_start", list]]) },
		]);
		const mode = modeWith(time, runtime);
		const rebind = mode.rebindCurrentSession;
		const colours = mode.themeController.waitForTerminalColors;
		await timeStart(mode, runtime, () => mode.init(), time.now);
		expect(mode.rebindCurrentSession).toBe(rebind);
		expect(mode.themeController.waitForTerminalColors).toBe(colours);
		expect(list).toEqual([handler]);
	});

	it("puts back a step pi keeps on its class, leaving no copy on the instance", async () => {
		const time = clock();
		class Mode {
			readonly themeController = {
				waitForTerminalColors: async () => time.pass(10),
			};
			rebindCurrentSession(): void {
				time.pass(20);
			}
			renderInitialMessages(): void {
				time.pass(30);
			}
			updateAvailableProviderCount(): void {
				time.pass(40);
			}
			async init(): Promise<void> {
				await this.themeController.waitForTerminalColors();
				this.rebindCurrentSession();
				this.renderInitialMessages();
				this.updateAvailableProviderCount();
			}
		}
		const mode = new Mode();
		const parts = await timeStart(mode, undefined, () => mode.init(), time.now);
		expect(partsOf(parts)).toEqual({
			colours: 10,
			bind: 20,
			draw: 30,
			providers: 40,
		});
		expect(Object.hasOwn(mode, "rebindCurrentSession")).toBe(false);
		expect(mode.rebindCurrentSession).toBe(Mode.prototype.rebindCurrentSession);
	});

	it("names the steps it times as pi's own InteractiveMode has them", () => {
		for (const step of [
			"rebindCurrentSession",
			"renderInitialMessages",
			"updateAvailableProviderCount",
		])
			expect(typeof Reflect.get(InteractiveMode.prototype, step), step).toBe(
				"function",
			);
	});

	it("starts untimed, all put back, when pi's handlers can't be wrapped", async () => {
		const time = clock();
		const list = Object.freeze([() => time.pass(5)]);
		const runtime = {
			session: {
				extensionRunner: {
					extensions: [
						{
							path: "/x/index.ts",
							handlers: new Map([["session_start", list]]),
						},
					],
				},
			},
		};
		const mode = modeWith(time, runtimeWith([]));
		const rebind = mode.rebindCurrentSession;
		const parts = await timeStart(mode, runtime, () => mode.init(), time.now);
		expect(parts.ms).toBe(1180);
		expect(partsOf(parts)).toEqual({
			colours: undefined,
			bind: undefined,
			draw: undefined,
			providers: undefined,
		});
		expect(mode.rebindCurrentSession).toBe(rebind);
	});

	it("lets a handler in two events be taken from the first while the screen started", async () => {
		const time = clock();
		const both: Handler = () => undefined;
		const first: Handler[] = [both];
		const second: Handler[] = [both];
		first.push(() => {
			const at = first.indexOf(both);
			if (at !== -1) first.splice(at, 1);
		});
		const runtime = runtimeWith([
			{
				path: "/x/index.ts",
				handlers: new Map([
					["session_start", first],
					["session_end", second],
				]),
			},
		]);
		const mode = modeWith(time, runtime);
		await timeStart(mode, runtime, () => mode.init(), time.now);
		expect(first).not.toContain(both);
		expect(second).toEqual([both]);
	});

	it("keeps a handler added while the screen started", async () => {
		const time = clock();
		const added: Handler = () => undefined;
		const list: Handler[] = [];
		list.push(() => {
			list.push(added);
		});
		const first = list[0];
		const runtime = runtimeWith([
			{ path: "/x/index.ts", handlers: new Map([["session_start", list]]) },
		]);
		const mode = modeWith(time, runtime);
		await timeStart(mode, runtime, () => mode.init(), time.now);
		expect(list).toEqual([first, added]);
	});

	it("lets a handler taken away while the screen started stay gone, as pi's unsubscribe takes it", async () => {
		const time = clock();
		const list: Handler[] = [];
		const once: Handler = () => {
			// What pi's on() hands back: find the handler, then splice it out.
			const at = list.indexOf(once);
			if (at !== -1) list.splice(at, 1);
		};
		list.push(once);
		const runtime = runtimeWith([
			{ path: "/x/index.ts", handlers: new Map([["session_start", list]]) },
		]);
		const mode = modeWith(time, runtime);
		await timeStart(mode, runtime, () => mode.init(), time.now);
		expect(list).toEqual([]);
		expect(Object.hasOwn(list, "indexOf")).toBe(false);
	});

	it("puts everything back, and rejects as the start did, when the start fails", async () => {
		const time = clock();
		const runtime = runtimeWith([]);
		const mode = modeWith(time, runtime);
		const rebind = mode.rebindCurrentSession;
		mode.renderInitialMessages = () => {
			throw new Error("the history would not draw");
		};
		await expect(
			timeStart(mode, runtime, () => mode.init(), time.now),
		).rejects.toThrow("the history would not draw");
		expect(mode.rebindCurrentSession).toBe(rebind);
	});

	it("goes untimed where pi lacks a step, its time falling in rest", async () => {
		const time = clock();
		const mode = {
			async init() {
				time.pass(900);
			},
		};
		const parts = await timeStart(mode, undefined, () => mode.init(), time.now);
		expect(startLine(parts)).toBe(
			"Screen started in 0.9 s (colours untimed, bind untimed, draw untimed, providers untimed, rest 0.9 s); no extension's handlers ran",
		);
	});
});

describe("a screen's start line", () => {
	it("names the steps, what's left, and the five slowest extensions", () => {
		const line = startLine({
			ms: 4600,
			steps: [
				{ name: "colours", ms: 100 },
				{ name: "bind", ms: 3200 },
				{ name: "draw", ms: 700 },
				{ name: "providers", ms: 100 },
			],
			extensions: [
				{ name: "a", ms: 1200 },
				{ name: "b", ms: 900 },
				{ name: "c", ms: 400 },
				{ name: "d", ms: 300 },
				{ name: "e", ms: 200 },
				{ name: "f", ms: 100 },
			],
		});
		expect(line).toBe(
			"Screen started in 4.6 s (colours 0.1 s, bind 3.2 s, draw 0.7 s, providers 0.1 s, rest 0.5 s); extensions' handlers 3.1 s, slowest a 1.2 s, b 0.9 s, c 0.4 s, d 0.3 s, e 0.2 s",
		);
	});
});

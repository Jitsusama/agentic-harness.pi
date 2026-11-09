/** Runner-local browser contexts and timers over one process-owned Chrome. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import browserIntegration from "../../../extensions/browser-integration/index.ts";
import { createSessionRegistry } from "../../../extensions/browser-integration/registry.ts";
import { lazySessions } from "../../../extensions/browser-integration/sessions.ts";
import { installHost } from "../../../lib/core/session/index.ts";
import { closeBrowser } from "../../../lib/core/web/browser.ts";
import { BrowserSession } from "../../../lib/core/web/session.ts";
import { extensionRunner } from "../../support/extension-runner.ts";

// Never launch or close a real Chrome. A process close destroys all page
// doubles, making an accidental cross-runner close observable below.
vi.mock("../../../lib/core/web/browser.ts", async (original) => ({
	...(await original<typeof import("../../../lib/core/web/browser.ts")>()),
	closeBrowser: vi.fn(async () => {}),
}));

const IDLE_MS = 30 * 60 * 1000;
const pages: Array<ReturnType<typeof pageDouble>> = [];
const cleanups: Array<() => void | Promise<void>> = [];

function pageDouble(name: string) {
	const page = {
		name,
		closed: false,
		lastUsedAt: Date.now(),
		close: vi.fn(async () => {
			page.closed = true;
		}),
	};
	return page;
}

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function sessionDouble(page: ReturnType<typeof pageDouble>): BrowserSession {
	// The registry uses only lifetime operations; page-engine operations are
	// deliberately unavailable so these tests cannot reach a real browser.
	return page as unknown as BrowserSession;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(closeBrowser).mockImplementation(async () => {
		for (const page of pages) page.closed = true;
	});
	vi.spyOn(BrowserSession, "open").mockImplementation(async (name) => {
		const page = pageDouble(name);
		pages.push(page);
		return sessionDouble(page);
	});
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	pages.length = 0;
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.useRealTimers();
});

function host() {
	cleanups.push(
		installHost({
			kind: "pi-durable",
			key: "test-browser-host",
			owner: { pid: process.pid, startedAt: Date.now() },
			holds: () => "idle",
			env: () => {
				throw new Error("Browser lifetime tests do not consume host env");
			},
			hints: () => ({}),
			close: () => {},
			stamp: () => {},
		}),
	);
}

async function runner(cwd: string) {
	const running = extensionRunner(browserIntegration, cwd);
	cleanups.push(() => running.stop());
	await running.start();
	return running;
}

describe("browser shutdown ownership", () => {
	it("closes only A's same-named session and timer while B keeps using Chrome", async () => {
		host();
		const a = await runner("/work/a");
		const b = await runner("/work/b");
		await a.call("browser_go", { kind: "open", session: "same" });
		await b.call("browser_go", { kind: "open", session: "same" });
		expect(pages).toHaveLength(2);
		expect(vi.getTimerCount()).toBe(2);

		await a.stop();
		expect(pages[0].close).toHaveBeenCalledOnce();
		expect(pages[1]).toMatchObject({ closed: false });
		expect(vi.getTimerCount()).toBe(1);
		expect(closeBrowser).not.toHaveBeenCalled();

		await b.call("browser_go", { kind: "open", session: "same" });
		expect(pages).toHaveLength(2);
		expect(pages[1]).toMatchObject({ closed: false });
		await b.stop();
		expect(pages[1].close).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
		expect(pages[0].close).toHaveBeenCalledOnce();
		expect(pages[1].close).toHaveBeenCalledOnce();
		expect(closeBrowser).not.toHaveBeenCalled();
		expect(a.errors).toEqual([]);
		expect(b.errors).toEqual([]);
	});

	it("explicit close and idle expiry keep names and departure memory local", async () => {
		const a = createSessionRegistry({ ownsBrowser: false, idleTimeoutMs: 20 });
		const b = createSessionRegistry({ ownsBrowser: false, idleTimeoutMs: 40 });
		cleanups.push(
			() => a.disposeAll(),
			() => b.disposeAll(),
		);
		await a.acquire("same");
		const second = await b.acquire("same");
		await a.close("same");
		expect(a.departureOf("same")).toBe("closed");
		expect(b.departureOf("same")).toBeUndefined();
		expect(b.open()).toEqual(["same"]);
		expect(await b.acquire("same")).toBe(second);
		await vi.advanceTimersByTimeAsync(40);
		expect(
			b.has("same"),
			"B's idle expiry removes only its own named session",
		).toBe(false);
		expect(b.departureOf("same")).toBe("idle");
		expect(pages[1].close).toHaveBeenCalledOnce();
		expect(closeBrowser).not.toHaveBeenCalled();
	});

	it("waits for a pending open but cancels every local timer before teardown", async () => {
		const pending = deferred<BrowserSession>();
		const page = pageDouble("pending");
		const second = pageDouble("second");
		const registry = createSessionRegistry({
			ownsBrowser: false,
			open: async (name) =>
				name === "pending" ? pending.promise : sessionDouble(second),
		});
		const opening = registry.acquire("pending");
		await registry.acquire("second");
		expect(vi.getTimerCount()).toBe(2);
		const disposing = registry.disposeAll();
		expect(registry.open()).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
		pending.resolve(sessionDouble(page));
		await Promise.all([opening, disposing]);
		expect(page.close).toHaveBeenCalledOnce();
		expect(second.close).toHaveBeenCalledOnce();
		expect(closeBrowser).not.toHaveBeenCalled();
	});

	it("does not let an already queued reaper revive a disposed timer during a call", async () => {
		const registry = createSessionRegistry({ ownsBrowser: false });
		await registry.acquire("running");
		const pending = deferred<void>();
		const call = registry.use("running", undefined, () => pending.promise);
		// Fire the timer synchronously, leaving its opening.then callback queued.
		vi.advanceTimersByTime(IDLE_MS);
		await registry.disposeAll();
		pending.resolve();
		await call;
		expect(pages[0].close).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		expect(closeBrowser).not.toHaveBeenCalled();
	});

	it("retains plain-pi runner disposal of local contexts and shared Chrome", async () => {
		const plain = await runner("/work/plain");
		await plain.call("browser_go", { kind: "open" });
		await plain.stop();
		expect(pages[0].close).toHaveBeenCalledOnce();
		expect(closeBrowser).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps default registry ownership and does nothing for unused lazy sessions", async () => {
		await lazySessions().disposeAll();
		expect(closeBrowser).not.toHaveBeenCalled();
		const registry = createSessionRegistry();
		await registry.acquire("plain");
		await registry.disposeAll();
		expect(pages[0].close).toHaveBeenCalledOnce();
		expect(closeBrowser).toHaveBeenCalledOnce();
	});
});

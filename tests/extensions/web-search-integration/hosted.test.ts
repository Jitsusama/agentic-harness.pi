/** Two web-search runners in one process keep their captures and leave shared Chrome alone. */
import { existsSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import webSearchIntegration from "../../../extensions/web-search-integration/index.ts";
import {
	installHost,
	type SessionRef,
} from "../../../lib/core/session/index.ts";
import { closeBrowser } from "../../../lib/core/web/browser.ts";
import { diskSink, sessionDir } from "../../../lib/core/web/envelope/sink.ts";
import { readPage } from "../../../lib/core/web/reader.ts";
import { extensionRunner } from "../../support/extension-runner.ts";

vi.mock("../../../lib/core/web/browser.ts", async (original) => ({
	...(await original<typeof import("../../../lib/core/web/browser.ts")>()),
	closeBrowser: vi.fn(async () => {}),
	killBrowserSync: vi.fn(),
}));
// The capture is faked; where its bundle lands is the real sink's choice.
vi.mock("../../../lib/core/web/reader.ts", async (original) => {
	const real =
		await original<typeof import("../../../lib/core/web/reader.ts")>();
	return {
		...real,
		readPage: vi.fn(
			async (url: string, _signal?: AbortSignal, ref?: SessionRef) =>
				real.assembleBundle(
					{
						url,
						title: url,
						html: "<p/>",
						innerText: "",
						article: null,
						tiles: [],
						truncated: false,
					},
					diskSink(undefined, ref),
				),
		),
	};
});

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.clearAllMocks();
});

function runner() {
	const loaded = extensionRunner(webSearchIntegration, process.cwd());
	const id = loaded.runner.createContext().sessionManager.getSessionId();
	cleanups.push(() => rmSync(sessionDir(id), { recursive: true, force: true }));
	return { ...loaded, id };
}
function host() {
	cleanups.push(
		installHost({
			kind: "pi-durable",
			key: "web-search-host",
			owner: { pid: process.pid, startedAt: Date.now() },
			holds: () => "idle",
			env: () => {
				throw new Error("Web-search lifetime tests do not consume host env");
			},
			hints: () => ({}),
			close: () => {},
			stamp: () => {},
		}),
	);
}
async function read(one: ReturnType<typeof runner>) {
	await one.call("web_read", { url: `https://example.com/${one.id}` });
}

describe("web-search in a host", () => {
	it("keeps each runner's bundles, and A's quit closes nothing B uses", async () => {
		host();
		const exits = process.listenerCount("exit");
		const a = runner();
		const b = runner();
		expect(
			process.listenerCount("exit"),
			"hosted runners add no exit listener to the host process",
		).toBe(exits);
		await a.start();
		await b.start();
		await read(a);
		await read(b);
		expect(vi.mocked(readPage).mock.calls.map((call) => call[2])).toEqual([
			expect.objectContaining({ sessionManager: expect.anything() }),
			expect.objectContaining({ sessionManager: expect.anything() }),
		]);
		expect(sessionDir(a.id)).not.toBe(sessionDir(b.id));
		await a.stop();
		expect(closeBrowser).not.toHaveBeenCalled();
		expect(
			existsSync(sessionDir(a.id)),
			"A's bundles survive a hosted quit",
		).toBe(true);
		expect(existsSync(sessionDir(b.id)), "B's bundles survive A's quit").toBe(
			true,
		);
		expect(a.errors).toEqual([]);
	});
});

describe("web-search on plain pi", () => {
	it("removes only the quitting runner's bundles and closes its Chrome", async () => {
		const before = new Set(process.listeners("exit"));
		const a = runner();
		const b = runner();
		cleanups.push(() => {
			// Each plain-pi load adds the orphan guard; take back only those.
			for (const listener of process.listeners("exit"))
				if (!before.has(listener)) process.removeListener("exit", listener);
		});
		expect(
			process.listenerCount("exit"),
			"plain pi keeps its orphaned-Chrome guard",
		).toBe(before.size + 2);
		await a.start();
		await b.start();
		await read(a);
		await read(b);
		await a.stop();
		expect(existsSync(sessionDir(a.id)), "A's quit removes A's bundles").toBe(
			false,
		);
		expect(existsSync(sessionDir(b.id)), "A's quit keeps B's bundles").toBe(
			true,
		);
		expect(closeBrowser).toHaveBeenCalledTimes(1);
	});
});

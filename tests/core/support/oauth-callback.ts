/**
 * The cases every OAuth callback server has to pass, whichever service it
 * waits for: it answers the one redirect, gives its port back, leaves no
 * clock running behind it, and stops when the person gives up.
 */

import { createServer } from "node:net";
import { expect, it } from "vitest";

/** What a callback server's waiting function looks like. */
export type WaitForCallback = (
	port: number,
	options?: { signal?: AbortSignal },
) => Promise<{ code?: string; error?: string }>;

/** A port nothing is listening on. */
export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "localhost", () => {
			const address = probe.address();
			probe.close(() =>
				typeof address === "object" && address !== null
					? resolve(address.port)
					: reject(new Error("no port")),
			);
		});
	});
}

/** Whether something could listen on `port` now. */
async function portIsFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createServer();
		probe.on("error", () => resolve(false));
		probe.listen(port, "localhost", () => probe.close(() => resolve(true)));
	});
}

async function listening(port: number): Promise<void> {
	const end = Date.now() + 2000;
	while (Date.now() < end) {
		if (!(await portIsFree(port))) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`nothing listened on ${port}`);
}

function timers(): number {
	return process.getActiveResourcesInfo().filter((kind) => kind === "Timeout")
		.length;
}

/** Registers the shared cases against one service's server. */
export function callbackServerCases(wait: WaitForCallback): void {
	it("answers the redirect, frees its port and leaves no clock running", async () => {
		const port = await freePort();
		const before = timers();
		const waiting = wait(port);
		await listening(port);

		await fetch(`http://localhost:${port}/?code=abc&state=s`);
		const result = await waiting;

		expect(result.code).toBe("abc");
		expect(await portIsFree(port)).toBe(true);
		expect(timers()).toBeLessThanOrEqual(before);
	});

	it("stops waiting and frees its port when its signal fires", async () => {
		const port = await freePort();
		const stop = new AbortController();
		const before = timers();
		const waiting = wait(port, { signal: stop.signal });
		await listening(port);

		stop.abort();

		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		expect(await portIsFree(port)).toBe(true);
		expect(timers()).toBeLessThanOrEqual(before);
	});

	it("never listens when its signal has already fired", async () => {
		const port = await freePort();
		const stop = new AbortController();
		stop.abort();

		await expect(wait(port, { signal: stop.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(await portIsFree(port)).toBe(true);
	});
}

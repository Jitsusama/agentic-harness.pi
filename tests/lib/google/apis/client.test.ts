import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	GOOGLE_REQUEST_TIMEOUT_MS,
	google,
} from "../../../../lib/google/apis/client.ts";

/** Longer than a request given up on should take to end. */
const STILL_RUNNING_MS = 3000;

/** The request's outcome, or a note that it was still waiting. */
async function outcome(call: Promise<unknown>): Promise<string> {
	const running = new Promise<string>((resolve) =>
		setTimeout(() => resolve("still running"), STILL_RUNNING_MS),
	);
	return Promise.race([
		call.then(
			() => "answered",
			(error: unknown) =>
				error instanceof Error ? `failed: ${error.name}` : "failed",
		),
		running,
	]);
}

// An API that accepts the connection and never answers is the shape of
// a request stuck behind a dead proxy or a peer that went quiet. The
// platform's timed-out signal is stood in for by one the test fires, so
// the clock can be proved without waiting it out.
describe("a Google API request nobody answers", () => {
	// The Drive client's module is large and loaded on first use. Loaded
	// inside the first test, under a loaded full suite, it ran past that
	// test's clock before any request was sent.
	beforeAll(() => {
		google.drive({ version: "v3" });
	}, 60_000);

	let server: Server;
	let rootUrl: string;
	let clocks: number[];
	let fire: AbortController;

	beforeEach(async () => {
		server = createServer(() => {
			// Never answer.
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		rootUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
		clocks = [];
		fire = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
			clocks.push(ms);
			return fire.signal;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("is sent under the request clock", async () => {
		const drive = google.drive({ version: "v3", rootUrl, retry: false });
		const call = drive.files.list({});
		setTimeout(() => fire.abort(), 200);
		await outcome(call);
		expect(clocks).toContain(GOOGLE_REQUEST_TIMEOUT_MS);
	});

	it("ends when that clock runs out", async () => {
		const drive = google.drive({ version: "v3", rootUrl, retry: false });
		const call = drive.files.list({});
		setTimeout(() => fire.abort(), 200);
		expect(await outcome(call)).toMatch(/^failed/);
	});
});

import { describe, expect, it } from "vitest";
import { workerSocket } from "../../../lib/mesh/worker-socket.ts";

describe("finding the worker socket", () => {
	it("takes an absolute path the machine names, and nothing else", () => {
		expect(workerSocket({ MYCELIUM_WORKER_SOCKET: "/run/worker.sock" })).toBe(
			"/run/worker.sock",
		);
		expect(workerSocket({ MYCELIUM_WORKER_SOCKET: "worker.sock" })).toBe(
			undefined,
		);
		expect(workerSocket({ MYCELIUM_WORKER_SOCKET: "" })).toBe(undefined);
		expect(workerSocket({})).toBe(undefined);
	});
});

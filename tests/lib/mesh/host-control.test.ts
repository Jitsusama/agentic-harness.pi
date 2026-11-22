/**
 * The host's client, loaded the first time a pi asks a host anything: a
 * load that fails says nothing was sent, and the next ask loads again.
 */
import { expect, it, vi } from "vitest";
import {
	controlRequest,
	HostClientUnloaded,
} from "../../../lib/mesh/host-control.ts";

const client = vi.hoisted(() => ({
	loads: 0,
	fails: true,
	asked: [] as unknown[][],
}));

vi.mock("../../../host/service/client.ts", () => {
	client.loads += 1;
	if (client.fails) throw new Error("Cannot find module 'zod'");
	return {
		controlRequest: async (...request: unknown[]) => {
			client.asked.push(request);
			return { v: 1, id: "list", ok: true, result: null };
		},
	};
});

it("fails as a client that didn't load, then loads it on the next ask", async () => {
	const request = { v: 1, id: "list", op: "list" } as const;

	const failed = await controlRequest("/run/host.sock", request).catch(
		(error: unknown) => error,
	);
	expect(failed).toBeInstanceOf(HostClientUnloaded);
	// vitest wraps a mock's thrown error in its own, so only the cause's
	// presence is checked, not its words.
	expect(String(failed)).toContain("the host's client didn't load");
	expect((failed as Error).cause).toBeInstanceOf(Error);
	expect(client.asked, "nothing was sent").toEqual([]);

	client.fails = false;
	expect(await controlRequest("/run/host.sock", request)).toMatchObject({
		ok: true,
	});
	expect(client.loads, "the failed load was forgotten").toBe(2);
	expect(client.asked).toEqual([["/run/host.sock", request]]);
});

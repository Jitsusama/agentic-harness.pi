/** A closed conversation abandons its fleet while its host and sibling live. */
import { afterEach, expect, it } from "vitest";
import { installHost, withSession } from "../../../lib/core/session/index.ts";
import type { TickFacts } from "../../../lib/internal/process-ticks.ts";
import {
	abandonedFleets,
	type FleetRun,
	whoIsWaiting,
} from "../../../lib/subagent/fleet.ts";
import { sessionHost } from "../../support/session-host.ts";

const OWNER = {
	pid: 123,
	startedAt: 1_760_000_000_000,
	bootId: "boot",
	startTicks: 77,
};
const facts: TickFacts = {
	alive: () => true,
	startedAt: async () => OWNER.startedAt,
	bootId: () => OWNER.bootId,
	startTicks: async () => OWNER.startTicks,
};
let removeHost: (() => void) | undefined;
afterEach(() => {
	removeHost?.();
	removeHost = undefined;
});

it("records separate waiters and abandons only the conversation that closed", async () => {
	const { host } = sessionHost(OWNER);
	removeHost = installHost(host);
	const a = await withSession("a", () => whoIsWaiting(facts));
	const b = await withSession("b", () => whoIsWaiting(facts));
	expect(a).toEqual({ ...OWNER, session: "a", host: host.key });
	expect(b).toEqual({ ...OWNER, session: "b", host: host.key });
	const runs: FleetRun[] = [a, b].map((owner, i) => ({
		id: i === 0 ? "fleet-a" : "fleet-b",
		startedAt: new Date().toISOString(),
		jobs: ["one"],
		open: true,
		owner,
	}));
	expect(await abandonedFleets(runs, facts)).toEqual([]);

	await host.close("a", "test");

	expect((await abandonedFleets(runs, facts)).map((run) => run.id)).toEqual([
		"fleet-a",
	]);
	expect(host.holds("b")).toBe("idle");
});

it("names the conversation it is told of, over the ambient one", async () => {
	const { host } = sessionHost(OWNER);
	removeHost = installHost(host);
	const b = await withSession("a", () => whoIsWaiting(facts, undefined, "b"));
	expect(b).toEqual({ ...OWNER, session: "b", host: host.key });
	expect(await whoIsWaiting(facts, undefined, "a")).toEqual({
		...OWNER,
		session: "a",
		host: host.key,
	});
});

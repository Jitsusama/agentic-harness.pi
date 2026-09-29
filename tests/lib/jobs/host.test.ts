/**
 * A producer finds the job host at the moment it needs one.
 *
 * A background job whose result nobody will say is worse than a
 * foreground one, so a producer has to know, before it returns to the
 * model, that a host is there. The bus answers synchronously, so asking
 * is enough.
 */

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	announceJobHost,
	findJobHost,
	type JobHost,
} from "../../../lib/jobs/index.ts";

const host: JobHost = {
	start: () => {
		throw new Error("not started in this test");
	},
};

describe("finding the job host", () => {
	it("finds nothing when no host is listening", () => {
		expect(findJobHost(createEventBus())).toBeUndefined();
	});

	it("finds the host that announced itself, whenever it did", () => {
		const bus = createEventBus();
		announceJobHost(bus, host);
		expect(findJobHost(bus)).toBe(host);
	});

	it("finds nothing once the host has gone", () => {
		const bus = createEventBus();
		const gone = announceJobHost(bus, host);
		gone();
		expect(findJobHost(bus)).toBeUndefined();
	});
});

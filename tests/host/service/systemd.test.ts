/**
 * How a host reads systemd: the service it runs in, from its cgroup, and
 * how often it pings the watchdog. The tellings themselves are driven
 * through runHost in run.test.ts, over a fake systemd-notify.
 */

import { describe, expect, it } from "vitest";
import {
	serviceOfCgroup,
	watchdogEvery,
} from "../../../host/service/systemd.ts";

describe("serviceOfCgroup", () => {
	it("names the service a host's unified hierarchy ends in", () => {
		expect(
			serviceOfCgroup(
				"0::/user.slice/user-1000.slice/user@1000.service/app.slice/pi-host-work-background.service\n",
			),
		).toBe("pi-host-work-background.service");
	});

	it("names none for a scope, a slice or no unified hierarchy", () => {
		for (const text of [
			"0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1.scope\n",
			"0::/user.slice\n",
			"1:name=systemd:/user.slice/pi-host-work-background.service\n",
			"",
		])
			expect(serviceOfCgroup(text), text).toBeUndefined();
	});
});

describe("watchdogEvery", () => {
	it("pings four times in each watchdog timeout, when systemd watches this process", () => {
		expect(watchdogEvery({ WATCHDOG_USEC: "120000000" }, 7)).toBe(30_000);
		expect(
			watchdogEvery({ WATCHDOG_USEC: "120000000", WATCHDOG_PID: "7" }, 7),
		).toBe(30_000);
	});

	it("doesn't ping without a watchdog, or for another process's", () => {
		for (const env of [
			{},
			{ WATCHDOG_USEC: "" },
			{ WATCHDOG_USEC: "0" },
			{ WATCHDOG_USEC: "soon" },
			{ WATCHDOG_USEC: "120000000", WATCHDOG_PID: "8" },
		])
			expect(watchdogEvery(env, 7), JSON.stringify(env)).toBeUndefined();
	});
});

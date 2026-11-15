import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	defaultInterfaceIn,
	UPLINK_WINDOW_MS,
	uplinkMeter,
	uplinkSentIn,
} from "../../../../lib/internal/priority/uplink.ts";

const ROUTE_HEADER =
	"Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n";
const route = (...lines: string[]) => ROUTE_HEADER + lines.join("\n");
const line = (
	iface: string,
	destination: string,
	metric: number,
	flags = "0003",
) =>
	`${iface}\t${destination}\t0104A8C0\t${flags}\t0\t0\t${metric}\t00000000\t0\t0\t0`;

describe("defaultInterfaceIn", () => {
	it("names the interface the default route leaves by", () => {
		expect(
			defaultInterfaceIn(
				route(
					line("wlp0s20f3", "00000000", 600),
					line("wlp0s20f3", "0004A8C0", 600),
				),
			),
		).toBe("wlp0s20f3");
	});

	it("takes the lowest metric when two default routes stand", () => {
		// A wired link beside Wi-Fi is the one the kernel sends by.
		expect(
			defaultInterfaceIn(
				route(
					line("wlp0s20f3", "00000000", 600),
					line("enp5s0", "00000000", 100),
				),
			),
		).toBe("enp5s0");
	});

	it("ignores a default route that's down, and says nothing with none", () => {
		expect(
			defaultInterfaceIn(route(line("enp5s0", "00000000", 100, "0002"))),
		).toBeUndefined();
		expect(
			defaultInterfaceIn(route(line("wlp0s20f3", "0004A8C0", 600))),
		).toBeUndefined();
		expect(defaultInterfaceIn("")).toBeUndefined();
	});
});

describe("uplinkSentIn", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "uplink-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("reads the bytes the default route's interface has sent", async () => {
		mkdirSync(join(root, "proc", "net"), { recursive: true });
		writeFileSync(
			join(root, "proc", "net", "route"),
			route(line("wlp0s20f3", "00000000", 600)),
		);
		mkdirSync(join(root, "net", "wlp0s20f3", "statistics"), {
			recursive: true,
		});
		writeFileSync(
			join(root, "net", "wlp0s20f3", "statistics", "tx_bytes"),
			"123456789\n",
		);
		expect(
			await uplinkSentIn({ proc: join(root, "proc"), net: join(root, "net") }),
		).toEqual({
			device: "wlp0s20f3",
			bytes: 123456789,
		});
	});

	it("says nothing where the route or the count can't be read", async () => {
		expect(
			await uplinkSentIn({ proc: join(root, "proc"), net: join(root, "net") }),
		).toBeUndefined();
		mkdirSync(join(root, "proc", "net"), { recursive: true });
		writeFileSync(
			join(root, "proc", "net", "route"),
			route(line("wlp0s20f3", "00000000", 600)),
		);
		expect(
			await uplinkSentIn({ proc: join(root, "proc"), net: join(root, "net") }),
		).toBeUndefined();
	});
});

describe("uplinkMeter", () => {
	const MB = 1_000_000 / 8;
	const at = (seconds: number) =>
		Date.parse("2026-11-15T07:00:00Z") + seconds * 1000;

	it("says nothing until a reading a window old stands to measure from", () => {
		const meter = uplinkMeter();
		expect(meter({ device: "wlp0s20f3", bytes: 0 }, at(0))).toBeUndefined();
		expect(
			meter({ device: "wlp0s20f3", bytes: 2 * MB }, at(5)),
		).toBeUndefined();
	});

	it("says how fast the line sends, in Mbit/s, over the last window", () => {
		// 14 November's storm: 6.4 Mbit/s for seventeen minutes.
		const meter = uplinkMeter();
		const window = UPLINK_WINDOW_MS / 1000;
		meter({ device: "wlp0s20f3", bytes: 0 }, at(0));
		expect(
			meter({ device: "wlp0s20f3", bytes: 6.4 * window * MB }, at(window)),
		).toBe(6.4);
		// Read every second, it measures from the reading a window back:
		// 2 Mbit each second since the storm's last reading.
		let sent = 6.4 * window * MB;
		for (let second = window + 1; second < 2 * window; second += 1) {
			sent += 2 * MB;
			meter({ device: "wlp0s20f3", bytes: sent }, at(second));
		}
		expect(
			meter({ device: "wlp0s20f3", bytes: sent + 2 * MB }, at(2 * window)),
		).toBe(2);
	});

	it("measures across a reading rarer than the window", () => {
		const meter = uplinkMeter();
		meter({ device: "wlp0s20f3", bytes: 0 }, at(0));
		expect(meter({ device: "wlp0s20f3", bytes: 30 * MB }, at(30))).toBe(1);
	});

	it("starts again when the interface changes or its count resets", () => {
		const meter = uplinkMeter();
		const window = UPLINK_WINDOW_MS / 1000;
		meter({ device: "wlp0s20f3", bytes: 100 * MB }, at(0));
		expect(
			meter({ device: "enp5s0", bytes: 200 * MB }, at(window)),
		).toBeUndefined();
		expect(
			meter({ device: "enp5s0", bytes: 10 * MB }, at(2 * window)),
		).toBeUndefined();
		expect(
			meter({ device: "enp5s0", bytes: 10 * MB + window * MB }, at(3 * window)),
		).toBe(1);
	});

	it("forgets what it measured once the route can't be read", () => {
		const meter = uplinkMeter();
		const window = UPLINK_WINDOW_MS / 1000;
		meter({ device: "wlp0s20f3", bytes: 0 }, at(0));
		expect(meter(undefined, at(window))).toBeUndefined();
		expect(
			meter({ device: "wlp0s20f3", bytes: 20 * MB }, at(2 * window)),
		).toBeUndefined();
	});
});

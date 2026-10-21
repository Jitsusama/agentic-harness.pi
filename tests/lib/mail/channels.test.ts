/**
 * Channels: how they are named, who hears them, and where a session's
 * place in them is kept.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	channelName,
	createMemberships,
	hears,
} from "../../../lib/mail/channels.ts";
import { isFor, type Mail, recipients } from "../../../lib/mail/mailbox.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mail-channels-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("a channel's name", () => {
	it("is made canonical, with or without its #", () => {
		expect(channelName("#Harness")).toBe("harness");
		expect(channelName(" optimus/power ")).toBe("optimus/power");
	});

	it("is nothing for the global channel, which is not joined", () => {
		expect(channelName("#global")).toBeUndefined();
		expect(channelName("all")).toBeUndefined();
	});

	it("is nothing for what cannot be one", () => {
		expect(channelName("#two words")).toBeUndefined();
		expect(channelName("optimus//power")).toBeUndefined();
		expect(channelName("#")).toBeUndefined();
	});
});

describe("who hears a channel", () => {
	it("is whoever is on it or on one of its sub-channels", () => {
		expect(hears(["optimus/power"], "optimus")).toBe(true);
		expect(hears(["optimus/power"], "optimus/power")).toBe(true);
		expect(hears(["optimus"], "optimus/power")).toBe(false);
		// A prefix that is not a parent is not one.
		expect(hears(["optimusprime"], "optimus")).toBe(false);
	});

	it("reaches a session through the mail's recipients", () => {
		const mail: Mail = {
			at: "2026-10-21T22:00:00.000Z",
			from: "P9R1KI",
			to: recipients("#optimus"),
			text: "rebooting at 19:00",
			kind: "hold",
			pid: 1,
		};
		expect(isFor(mail, ["WCJQSG"], 2, ["optimus/power"])).toBe(true);
		expect(isFor(mail, ["OVAE1I"], 2, ["skynet"])).toBe(false);
	});

	it("is written as a person types it", () => {
		expect(recipients("#Harness, #global, all, p9r1ki")).toEqual([
			"#harness",
			"ALL",
			"P9R1KI",
		]);
	});
});

describe("memberships", () => {
	it("keep a session's channels by its session id", () => {
		const kept = createMemberships(dir);
		kept.keep({ session: "s-1", names: ["7M6JKG"], channels: ["harness"] });

		expect(createMemberships(dir).of("s-1").channels).toEqual(["harness"]);
		expect(createMemberships(dir).of("s-2")).toEqual({
			session: "s-2",
			names: [],
			channels: [],
		});
	});

	it("list every session's record, passing over one that will not read", () => {
		const kept = createMemberships(dir);
		kept.keep({ session: "s-1", names: ["A"], channels: [] });
		kept.keep({ session: "s-2", names: ["B"], channels: ["harness"] });
		writeFileSync(join(dir, "torn.json"), "{", "utf8");

		expect(
			kept
				.all()
				.map((one) => one.session)
				.sort(),
		).toEqual(["s-1", "s-2"]);
	});
});

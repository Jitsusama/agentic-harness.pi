/**
 * A machine that turns direct Slack off leaves the tool gateway as the
 * only way to Slack: nothing in the package reads the stored token,
 * signs in, takes a browser's session or calls Slack's API, and the
 * slack tool and its sign-in commands are gone, while the gate on the
 * gateway's own writes stays.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePi } from "../../support/fake-pi.ts";

// The keyring must never be reached while direct Slack is off, so any
// read, write or move of the stored document fails the test.
const touched = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../../lib/core/internal/keyring/document.ts", () => ({
	credentialsDocument: () => ({
		read: async () => {
			touched.count += 1;
			return { token: { accessToken: "xoxp-stored", userId: "U1" } };
		},
		write: async () => {
			touched.count += 1;
		},
		moveIfPresent: async () => {
			touched.count += 1;
		},
	}),
}));

const { DirectSlackRefused, directSlackRefused } = await import(
	"../../../lib/slack/policy.ts"
);
const { SlackClient } = await import("../../../lib/slack/api/client.ts");
const { getToken, hasToken, storeToken } = await import(
	"../../../lib/slack/auth/credentials.ts"
);
const { moveToKeyring } = await import("../../../lib/slack/auth/store.ts");
const { ensureAuthenticated } = await import(
	"../../../lib/slack/auth/ensure-auth.ts"
);
const { extractFromBrowser } = await import(
	"../../../lib/slack/auth/browser-extract.ts"
);
const { default: slackIntegration } = await import(
	"../../../extensions/slack-integration/index.ts"
);

let config: string;
let before: string | undefined;

/** Turn direct Slack off, as the machine's configuration does. */
function turnOff(): void {
	mkdirSync(join(config, "agentic-harness", "slack"), { recursive: true });
	writeFileSync(join(config, "agentic-harness", "slack", "gateway-only"), "");
}

beforeEach(() => {
	config = mkdtempSync(join(tmpdir(), "direct-slack-off-"));
	before = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = config;
	touched.count = 0;
});

afterEach(() => {
	if (before === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = before;
	rmSync(config, { recursive: true, force: true });
});

describe("with direct Slack off", () => {
	beforeEach(turnOff);

	it("finds no stored token, without reaching the keyring", async () => {
		expect(directSlackRefused()).toBe(true);
		expect(await getToken()).toBeNull();
		expect(await hasToken()).toBe(false);
		await moveToKeyring();
		expect(touched.count).toBe(0);
	});

	it("refuses to store a token", async () => {
		await expect(
			storeToken({ accessToken: "xoxp-new", userId: "U1" } as never),
		).rejects.toBeInstanceOf(DirectSlackRefused);
		expect(touched.count).toBe(0);
	});

	it("refuses every direct call to Slack's API", () => {
		expect(() => new SlackClient("xoxp-stored")).toThrow(DirectSlackRefused);
	});

	it("refuses to sign in or take a browser's session", async () => {
		await expect(
			ensureAuthenticated({ hasUI: true } as never, {
				clientId: "",
				clientSecret: "",
			}),
		).rejects.toBeInstanceOf(DirectSlackRefused);
		await expect(extractFromBrowser()).rejects.toBeInstanceOf(
			DirectSlackRefused,
		);
	});

	it("registers no slack tool or sign-in command, and still gates the gateway's writes", () => {
		const pi = fakePi();
		slackIntegration(pi);
		expect(pi.recorded.tools.map((tool) => tool.name)).not.toContain("slack");
		expect([...pi.recorded.commands.keys()]).toEqual([]);
		expect(pi.recorded.handlers.get("tool_call")).toHaveLength(1);
	});
});

describe("with direct Slack on", () => {
	it("reads the stored token and registers the slack tool", async () => {
		expect(directSlackRefused()).toBe(false);
		expect((await getToken())?.accessToken).toBe("xoxp-stored");
		expect(() => new SlackClient("xoxp-stored")).not.toThrow();
		const pi = fakePi();
		slackIntegration(pi);
		expect(pi.recorded.tools.map((tool) => tool.name)).toContain("slack");
		expect(pi.recorded.commands.has("slack-auth")).toBe(true);
	});
});

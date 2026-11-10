/** Code that reads process.env in a host sees its own conversation's. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	type ConversationRegistration,
	SessionHost,
} from "../../../host/engine/index.ts";
import { sessionEnv, withSession } from "../../../lib/core/session/index.ts";

const owner = { pid: 123, startedAt: 1000, bootId: "boot", startTicks: 20 };
const own = process.env;
/** Stand-ins for the host's credentials, so no real key is read or shown. */
const CREDENTIALS = {
	SHOPIFY_PROXY_KEY: "host-key",
	PI_PROXY_API_KEY: "host-api-key",
} as const;
const saved = Object.fromEntries(
	Object.keys(CREDENTIALS).map((name) => [name, own[name]]),
);
beforeEach(() => {
	Object.assign(own, CREDENTIALS);
});
let host: SessionHost | undefined;
let dir: string | undefined;
afterEach(async () => {
	if (host) {
		for (const { id } of host.list()) await host.close(id);
		host.dispose();
		host = undefined;
	}
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
	delete own.K4_HOST_ONLY;
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete own[name];
		else own[name] = value;
	}
});

function start(): SessionHost {
	dir = mkdtempSync(join(tmpdir(), "conversation-env-"));
	host = new SessionHost({ key: "test-host", owner, registryDir: dir });
	return host;
}

function registration(
	id: string,
	env: Record<string, string>,
): ConversationRegistration {
	return {
		id,
		file: `/sessions/${id}.jsonl`,
		cwd: `/repo/${id}`,
		env: { PATH: own.PATH ?? "", ...env },
		hints: {},
		close: () => {},
	};
}

/** Two conversations with their own attribution, as a launcher sets it. */
function twoConversations(): SessionHost {
	const started = start();
	started.register(
		registration("a", {
			DEV_INVOCATION_ID: "inv-a",
			SHOPIFY_HARNESS_SETTINGS: '{"surface":"interactive"}',
		}),
	);
	started.register(
		registration("b", {
			DEV_INVOCATION_ID: "inv-b",
			SHOPIFY_HARNESS_SETTINGS: '{"surface":"headless"}',
		}),
	);
	return started;
}

it("reads each conversation's own variables, and the host's outside them", () => {
	own.K4_HOST_ONLY = "host";
	const started = twoConversations();
	expect(started.run("a", () => process.env.DEV_INVOCATION_ID)).toBe("inv-a");
	expect(started.run("b", () => process.env.DEV_INVOCATION_ID)).toBe("inv-b");
	expect(started.run("a", () => process.env.K4_HOST_ONLY)).toBeUndefined();
	expect(process.env.K4_HOST_ONLY).toBe("host");
	expect(process.env.DEV_INVOCATION_ID).toBe(own.DEV_INVOCATION_ID);
});

it("keeps a write or delete inside its conversation", () => {
	const started = twoConversations();
	started.run("a", () => {
		process.env.PI_WORKTRAIL_RUN = "run-a";
		delete process.env.DEV_INVOCATION_ID;
	});
	expect(sessionEnv("a").get("PI_WORKTRAIL_RUN")).toBe("run-a");
	expect(sessionEnv("a").get("DEV_INVOCATION_ID")).toBeUndefined();
	expect(started.run("b", () => process.env.PI_WORKTRAIL_RUN)).toBeUndefined();
	expect(sessionEnv("b").get("DEV_INVOCATION_ID")).toBe("inv-b");
	expect(own.PI_WORKTRAIL_RUN).toBe(undefined);
});

it("coerces what it stores to a string, as process.env does", () => {
	const started = twoConversations();
	started.run("a", () => {
		Object.assign(process.env, { PORT: 8080 });
	});
	expect(sessionEnv("a").get("PORT")).toBe("8080");
});

it("lists and spreads the conversation's keys", () => {
	const started = twoConversations();
	const spread = started.run("b", () => ({ ...process.env }));
	expect(spread.DEV_INVOCATION_ID).toBe("inv-b");
	expect(spread.PI_SESSION_ID).toBe("b");
	expect(
		started.run("b", () => "DEV_INVOCATION_ID" in process.env),
		"the conversation's variable is in process.env",
	).toBe(true);
	// The conversation's own keys, and the host's credentials beside them.
	expect(started.run("a", () => Object.keys(process.env).sort())).toEqual([
		"DEV_INVOCATION_ID",
		"PATH",
		"PI_PROXY_API_KEY",
		"PI_SESSION_ID",
		"SHOPIFY_HARNESS_SETTINGS",
		"SHOPIFY_PROXY_KEY",
	]);
});

it("hands a child started with no env the conversation's", () => {
	const started = twoConversations();
	const said = started.run("a", () =>
		execFileSync("sh", ["-c", 'printf %s "$DEV_INVOCATION_ID"'], {
			encoding: "utf8",
		}),
	);
	expect(said).toBe("inv-a");
});

it("never serves a proxy key from a conversation's env", () => {
	const started = start();
	started.register(
		registration("a", { SHOPIFY_PROXY_KEY: "conversation-key" }),
	);
	expect(started.run("a", () => process.env.SHOPIFY_PROXY_KEY)).toBe(
		"host-key",
	);
	expect(
		started
			.run("a", () => Object.keys(process.env))
			.filter((name) => name === "SHOPIFY_PROXY_KEY"),
	).toEqual(["SHOPIFY_PROXY_KEY"]);
	started.run("a", () => {
		process.env.PI_PROXY_API_KEY = "written-here";
	});
	expect(own.PI_PROXY_API_KEY).toBe("host-api-key");
	expect(sessionEnv("a").get("PI_PROXY_API_KEY")).toBe("written-here");
});

it("keeps a conversation's view across an await", async () => {
	const started = twoConversations();
	const [a, b] = await Promise.all(
		["a", "b"].map((id) =>
			started.run(id, async () => {
				await new Promise((settle) => setImmediate(settle));
				return process.env.DEV_INVOCATION_ID;
			}),
		),
	);
	expect([a, b]).toEqual(["inv-a", "inv-b"]);
});

it("writes to the host's own env outside any conversation", () => {
	twoConversations();
	process.env.K4_HOST_ONLY = "written";
	expect(own.K4_HOST_ONLY).toBe("written");
	delete process.env.K4_HOST_ONLY;
	expect(own.K4_HOST_ONLY).toBeUndefined();
	expect(sessionEnv("a").get("K4_HOST_ONLY")).toBeUndefined();
});

it("answers with the host's env for a conversation it no longer holds", async () => {
	own.K4_HOST_ONLY = "host";
	const started = twoConversations();
	await started.close("a");
	expect(withSession("a", () => process.env.K4_HOST_ONLY)).toBe("host");
});

it("drops what a released conversation's late work writes", async () => {
	own.K4_HOST_ONLY = "host";
	const started = twoConversations();
	await started.close("a");
	withSession("a", () => {
		process.env.PI_WORKTRAIL_RUN = "late-a";
		Object.defineProperty(process.env, "K4_DEFINED", { value: "late-a" });
		delete process.env.K4_HOST_ONLY;
	});
	expect(own.PI_WORKTRAIL_RUN).toBeUndefined();
	expect(own.K4_DEFINED).toBeUndefined();
	expect(own.K4_HOST_ONLY).toBe("host");
	expect(started.run("b", () => process.env.PI_WORKTRAIL_RUN)).toBeUndefined();
});

it("puts the host's own env back when the host is disposed", () => {
	const started = start();
	expect(process.env).not.toBe(own);
	started.dispose();
	host = undefined;
	expect(process.env).toBe(own);
});

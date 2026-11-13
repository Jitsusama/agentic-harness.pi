/** Code that reads process.env in a host sees its own conversation's. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
	PI_PROXY_AUTH_HEADER: "host-auth-header",
} as const;
/** Host variables the tests write or expect absent, which the runner's own env may hold. */
const CLEARED = [
	"PI_WORKTRAIL_RUN",
	"PORT",
	"K4_HOST_ONLY",
	"K4_DEFINED",
	"AI_PROXY_HEADERS_BIN",
	"WORKTRAIL_BIN",
	"PI_IMAGE_PROTOCOL",
	"PI_TRUE_COLOR",
	"PI_HYPERLINKS",
];
/** Stand-ins for the tools a host runtime pins for itself. */
const RUNTIME_TOOLS = {
	AI_PROXY_HEADERS_BIN: "/runtime/libexec/ai-proxy-headers",
	WORKTRAIL_BIN: "/runtime/libexec/worktrail",
} as const;
/** The viewers' terminal, as the host program names it for pi-tui. */
const VIEWERS_TERMINAL = {
	PI_IMAGE_PROTOCOL: "kitty",
	PI_TRUE_COLOR: "1",
	PI_HYPERLINKS: "1",
} as const;
const saved = Object.fromEntries(
	[...Object.keys(CREDENTIALS), ...CLEARED].map((name) => [name, own[name]]),
);
beforeEach(() => {
	for (const name of CLEARED) delete own[name];
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
		"PI_PROXY_AUTH_HEADER",
		"PI_SESSION_ID",
		"SHOPIFY_HARNESS_SETTINGS",
		"SHOPIFY_PROXY_KEY",
	]);
});

it("lists a conversation's keys without copying its environment", () => {
	// Every child started with no env of its own lists process.env, and
	// on the host's one loop a copy each time is every conversation's wait.
	const started = twoConversations();
	const copies = vi.spyOn(started.env("a"), "snapshot");
	const listed = () => started.run("a", () => Object.keys(process.env));
	expect(listed()).toContain("DEV_INVOCATION_ID");
	started.run("a", () => {
		process.env.PI_WORKTRAIL_RUN = "run-a";
		delete process.env.DEV_INVOCATION_ID;
	});
	expect(listed(), "the list follows the conversation's writes").toContain(
		"PI_WORKTRAIL_RUN",
	);
	expect(listed(), "and its deletes").not.toContain("DEV_INVOCATION_ID");
	expect(copies, "listing never copied the environment").not.toHaveBeenCalled();
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

it("reads the runtime's tools and the viewers' terminal in the host, but never hands them to a child", () => {
	Object.assign(own, RUNTIME_TOOLS, VIEWERS_TERMINAL);
	const started = twoConversations();
	expect(
		started.run("a", () => process.env.AI_PROXY_HEADERS_BIN),
		"read in the host's own process",
	).toBe(RUNTIME_TOOLS.AI_PROXY_HEADERS_BIN);
	expect(started.run("a", () => process.env.PI_TRUE_COLOR)).toBe("1");
	expect(started.run("a", () => process.env.WORKTRAIL_BIN)).toBe(
		RUNTIME_TOOLS.WORKTRAIL_BIN,
	);
	const listed = started.run("a", () => ({
		keys: Object.keys(process.env),
		spread: { ...process.env },
	}));
	for (const name of Object.keys({ ...RUNTIME_TOOLS, ...VIEWERS_TERMINAL })) {
		expect(listed.keys).not.toContain(name);
		expect(listed.spread).not.toHaveProperty(name);
	}
	const handed = started.run("a", () =>
		execFileSync(
			"sh",
			["-c", 'printf %s "$AI_PROXY_HEADERS_BIN$WORKTRAIL_BIN$PI_TRUE_COLOR"'],
			{ encoding: "utf8" },
		),
	);
	expect(handed, "a child finds its own on PATH").toBe("");
	expect(started.hostReads()).toEqual({
		...RUNTIME_TOOLS,
		...VIEWERS_TERMINAL,
	});
});

it("keeps a tool a conversation names for itself, and hands it on", () => {
	Object.assign(own, RUNTIME_TOOLS);
	const started = start();
	started.register(
		registration("a", { AI_PROXY_HEADERS_BIN: "/launcher/ai-proxy-headers" }),
	);
	expect(started.run("a", () => process.env.AI_PROXY_HEADERS_BIN)).toBe(
		"/launcher/ai-proxy-headers",
	);
	expect(
		started.run("a", () =>
			execFileSync("sh", ["-c", 'printf %s "$AI_PROXY_HEADERS_BIN"'], {
				encoding: "utf8",
			}),
		),
	).toBe("/launcher/ai-proxy-headers");
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

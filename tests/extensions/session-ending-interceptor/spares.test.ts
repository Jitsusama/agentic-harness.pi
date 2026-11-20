/**
 * What this machine knows of itself lets an ask through that would
 * otherwise be refused: a log-out its sessions outlive, and the asks of
 * a session whose hold of a disruption its sessions answered once
 * parked; anything unread spares nothing.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	nodeDeps,
	sessionEndingInterceptor,
} from "../../../extensions/session-ending-interceptor/index.ts";
import type { SessionEndingDeps } from "../../../extensions/session-ending-interceptor/refuse.ts";
import { forgetRedirects } from "../../../lib/guardian/apply.ts";
import { setSessionMode } from "../../../lib/guardian/policy.ts";
import type { NodeSession } from "../../../lib/mesh/node.ts";
import { type FakePi, fakePi } from "../../support/fake-pi.ts";

const SELF = "self-session";
const GUARD = "no-session-ending-ask-while-live";

const ctx = { sessionManager: { getSessionId: () => SELF } };

const me: NodeSession = {
	id: SELF,
	address: "0IM95G",
	machine: "optimus",
	state: "busy",
};

const hosted = (state: string): NodeSession => ({
	id: "hosted",
	address: "H00001",
	machine: "optimus",
	state,
	host: "work-background",
});

let pi: FakePi;
let askedOf: (string | undefined)[];

/** The interceptor over `node`'s sessions, its spares answering `spares`. */
function interceptorOver(
	node: readonly NodeSession[],
	spares: SessionEndingDeps["spares"],
): void {
	pi = fakePi();
	sessionEndingInterceptor({
		onMesh: () => true,
		sessions: async () => node,
		machines: async () => undefined,
		here: () => "optimus",
		spares,
	})(pi);
}

/** Spares answering `lingers` and `parked`, noting whom they were asked of. */
const answering =
	(lingers: boolean, parked: string[] = []): SessionEndingDeps["spares"] =>
	async (address) => {
		askedOf.push(address);
		return { lingers, parked: new Set(parked) };
	};

const handler = (event: string) => {
	const [one] = pi.recorded.handlers.get(event) ?? [];
	if (!one) throw new Error(`nothing listens for ${event}`);
	return one;
};

const reply = (said: string) =>
	handler("message_end")(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: said }],
				stopReason: "stop",
			},
		},
		ctx,
	);

const look = (ask: string) =>
	handler("tool_call")(
		{
			type: "tool_call",
			toolName: "show_person",
			toolCallId: "c1",
			input: {
				kind: "page",
				target: "https://example.org/bios",
				title: "BIOS 1.13.0",
				ask,
			},
		},
		ctx,
	);

beforeEach(() => {
	askedOf = [];
	setSessionMode(GUARD, "block");
	forgetRedirects();
});

describe("what spares this machine's sessions", () => {
	it("lets a log-out through that ends no session, all being hosted", async () => {
		interceptorOver([hosted("busy"), me], answering(true));

		expect(await reply("Please log out of niri on optimus.")).toBeUndefined();
		expect(askedOf).toEqual(["0IM95G"]);
	});

	it("still withholds a reboot of hosted sessions", async () => {
		interceptorOver([hosted("busy"), me], answering(true));

		expect(await reply("Please reboot optimus.")).toBeDefined();
	});

	it("lets the holder's own reboot through past the sessions that parked", async () => {
		interceptorOver([hosted("idle"), me], answering(false, ["hosted"]));

		expect(await look("Reboot optimus to install it")).toBeUndefined();
	});

	it("refuses that reboot when nobody parked, so the look's ask is read", async () => {
		interceptorOver([hosted("idle"), me], answering(false));

		expect(await look("Reboot optimus to install it")).toMatchObject({
			block: true,
		});
	});

	it("still refuses the holder's reboot of a session still busy", async () => {
		interceptorOver([hosted("busy"), me], answering(false, ["hosted"]));

		expect(await look("Reboot optimus to install it")).toMatchObject({
			block: true,
		});
	});

	it("refuses as before when what spares can't be read", async () => {
		interceptorOver([hosted("idle"), me], async () => {
			throw new Error("logind went away");
		});

		expect(await look("Reboot optimus to install it")).toMatchObject({
			block: true,
		});
	});

	it("asks nothing of what spares when the ask would go ahead anyway", async () => {
		interceptorOver([me], answering(false));

		await reply("Please reboot optimus.");
		await reply("All done here.");

		expect(askedOf).toEqual([]);
	});
});

describe("what spares, read by default", () => {
	let bin: string;
	beforeEach(() => {
		bin = mkdtempSync(join(tmpdir(), "session-ending-spares-"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(bin, { recursive: true, force: true });
	});

	/** A command on the test's PATH that runs `body` in sh. */
	const stub = (name: string, body: string) => {
		const path = join(bin, name);
		writeFileSync(path, `#!/bin/sh\n${body}\n`);
		chmodSync(path, 0o755);
	};

	/** A session's leases on the board, as the mesh writes them. */
	const leases = (session: string, kind: string, why: string) => {
		const dir = join(
			bin,
			"pi",
			"agentic-harness.pi",
			"mesh-workflow",
			"leases",
		);
		mkdirSync(dir, { recursive: true });
		const until = new Date(Date.now() + 60_000).toISOString();
		writeFileSync(
			join(dir, `${session}.json`),
			JSON.stringify({
				session,
				leases: [
					{
						kind,
						subject: "1795156260318-WCJQSG-36083-8e7eac05",
						since: new Date().toISOString(),
						until,
						why,
					},
				],
			}),
		);
	};

	it("asks logind of this user, and the board who parked for the asker", async () => {
		vi.stubEnv("XDG_STATE_HOME", bin);
		stub("loginctl", `[ "$2" = "${userInfo().uid}" ] && echo yes || echo no`);
		stub("busctl", 'echo "b false"');
		leases("holder", "hold", "WCJQSG hold: rebooting optimus for its BIOS");
		leases("hosted", "wait", "H00001 holding. Waiting on it: parked");
		const deps = nodeDeps({
			MYCELIUM_REALM: "work",
			XDG_STATE_HOME: bin,
			PATH: `${bin}:/usr/bin:/bin`,
		});

		expect(await deps.spares?.("WCJQSG")).toEqual({
			lingers: true,
			parked: new Set(["hosted"]),
		});
		expect(await deps.spares?.("0IM95G")).toEqual({
			lingers: true,
			parked: new Set(),
		});
	});
});

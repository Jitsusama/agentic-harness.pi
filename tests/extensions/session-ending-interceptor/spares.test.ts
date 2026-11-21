/**
 * What this machine knows of itself lets an ask through that would
 * otherwise be refused: a log-out its sessions outlive, and any ask
 * past the sessions that parked; anything unread spares nothing.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
import { ownerNow } from "../../../lib/core/process/process.ts";
import { forgetRedirects } from "../../../lib/guardian/apply.ts";
import { setSessionMode } from "../../../lib/guardian/policy.ts";
import { machineBooted } from "../../../lib/internal/machine/booted.ts";
import { stateDir } from "../../../lib/internal/paths.ts";
import { writeParked } from "../../../lib/internal/session/park.ts";
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
let asked = 0;

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

/** Spares answering `lingers` and `parked`, counting how often asked. */
const answering =
	(lingers: boolean, parked: string[] = []): SessionEndingDeps["spares"] =>
	async () => {
		asked += 1;
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

const look = (ask: string, why?: string) =>
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
				...(why === undefined ? {} : { why }),
			},
		},
		ctx,
	);

beforeEach(() => {
	asked = 0;
	setSessionMode(GUARD, "block");
	forgetRedirects();
});

describe("what spares this machine's sessions", () => {
	it("lets a log-out through that ends no session, all being hosted", async () => {
		interceptorOver([hosted("busy"), me], answering(true));

		expect(await reply("Please log out of niri on optimus.")).toBeUndefined();
		expect(asked).toBe(1);
	});

	it("withholds a log-out whose command, said after it, ends the hosts too", async () => {
		interceptorOver([hosted("busy"), me], answering(true));

		expect(
			await reply(
				"Please log out of niri on optimus. The quickest way is `loginctl terminate-user joel`.",
			),
		).toBeDefined();
	});

	it("refuses a reboot past parked sessions whose command keeps the boot", async () => {
		interceptorOver([hosted("idle"), me], answering(false, ["hosted"]));

		expect(
			await look("Reboot optimus. Use `sudo systemctl soft-reboot` for it"),
		).toMatchObject({ block: true });
	});

	it("refuses a look whose command, in another field, keeps the boot", async () => {
		interceptorOver([hosted("idle"), me], answering(false, ["hosted"]));

		expect(
			await look(
				"Reboot optimus to install it",
				"The quickest way is `sudo systemctl soft-reboot`, which keeps the kernel.",
			),
		).toMatchObject({ block: true });
	});

	it("refuses a reboot past parked sessions whose code reboots another machine", async () => {
		const there: NodeSession = {
			id: "there",
			address: "T00001",
			machine: "equilibrius",
			state: "busy",
		};
		interceptorOver([hosted("idle"), there, me], answering(false, ["hosted"]));

		expect(
			await look("Reboot optimus. Then `ssh equilibrius sudo reboot` for it"),
		).toMatchObject({ block: true });
	});

	it.each([
		"Reboot optimus. Then `ssh joel@10.0.0.7 sudo reboot` for it",
		"Reboot optimus. Then the same on equilibrius: `sudo reboot`",
	])(
		"refuses %s past parked sessions, with another machine busy",
		async (ask) => {
			const there: NodeSession = {
				id: "there",
				address: "T00001",
				machine: "equilibrius",
				state: "busy",
			};
			interceptorOver(
				[hosted("idle"), there, me],
				answering(false, ["hosted"]),
			);

			expect(await look(ask)).toMatchObject({ block: true });
		},
	);

	it("still withholds a reboot of hosted sessions", async () => {
		interceptorOver([hosted("busy"), me], answering(true));

		expect(await reply("Please reboot optimus.")).toBeDefined();
	});

	it("lets a reboot through past the sessions that parked", async () => {
		interceptorOver([hosted("idle"), me], answering(false, ["hosted"]));

		expect(await look("Reboot optimus to install it")).toBeUndefined();
	});

	it("refuses that reboot when nobody parked, so the look's ask is read", async () => {
		interceptorOver([hosted("idle"), me], answering(false));

		expect(await look("Reboot optimus to install it")).toMatchObject({
			block: true,
		});
	});

	it("still refuses a reboot of a session busy since it parked", async () => {
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

		expect(asked).toBe(0);
	});
});

describe("a spare beside the commands a reply shows", () => {
	const parked = () =>
		interceptorOver([hosted("idle"), me], answering(false, ["hosted"]));
	const lingering = () =>
		interceptorOver([hosted("busy"), me], answering(true));

	it.each([
		"Please reboot optimus.",
		"Please reboot optimus with `sudo systemctl reboot`.",
		"Please reboot optimus:\n\n```sh\n# from a terminal\n$ sudo reboot\n```",
	])(
		"lets a parked reboot through beside only plain commands: %s",
		async (said) => {
			parked();

			expect(await reply(said)).toBeUndefined();
		},
	);

	it.each([
		"Please reboot optimus. First run `sudo systemctl rescue`.",
		"Please reboot optimus, or `sudo init 1` if it hangs.",
		"Please reboot optimus. If it hangs, sudo kexec -e brings it back.",
		"Please reboot optimus:\n\n```sh\nsudo systemctl isolate rescue.target\n```",
	])("spares nothing beside a command off the plain list: %s", async (said) => {
		parked();

		expect(await reply(said)).toBeDefined();
		expect(
			pi.recorded.entries.map((entry) => entry.data),
			"refused for its commands, not for nothing being parked",
		).toMatchObject([{ outcome: "not plain" }]);
	});

	it("says nothing of commands where no spare would have stood anyway", async () => {
		interceptorOver([hosted("busy"), me], answering(false));

		const verdict = await look("Reboot optimus with `sudo systemctl rescue`");

		expect(verdict).toMatchObject({ block: true });
		expect(verdict).not.toMatchObject({
			reason: expect.stringMatching(/not all plain|none was spared/),
		});
		expect(pi.recorded.entries).toEqual([]);
	});

	it("lets a log-out through beside a plain command", async () => {
		lingering();

		expect(
			await reply(
				"Please log out of niri on optimus with `loginctl terminate-session`.",
			),
		).toBeUndefined();
	});

	it("spares nothing for a log-out beside one that ends the user manager", async () => {
		lingering();

		expect(
			await reply(
				"Please log out of niri on optimus, then `systemctl --user exit`.",
			),
		).toBeDefined();
	});
});

describe("what a spare leaves in the session's log", () => {
	const traces = () =>
		pi.recorded.entries.filter(
			(entry) => entry.customType === "session-ending-spare",
		);

	it("names the sessions a spare let an ask past, and why", async () => {
		interceptorOver([hosted("idle"), me], answering(false, ["hosted"]));

		await look("Reboot optimus to install it");

		expect(traces()).toEqual([
			{
				customType: "session-ending-spare",
				data: {
					outcome: "spared",
					asks: [{ act: "reboot", machines: ["optimus"] }],
					spared: [{ address: "H00001", why: "parked" }],
				},
			},
		]);
	});

	it("says, and logs, that what spares couldn't be read", async () => {
		interceptorOver([hosted("idle"), me], async () => {
			throw new Error("logind went away");
		});

		const verdict = await look("Reboot optimus to install it");

		expect(verdict).toMatchObject({
			block: true,
			reason: expect.stringMatching(
				/couldn't be read \(logind went away\), so none was spared/,
			),
		});
		expect(traces()).toMatchObject([
			{ data: { outcome: "unread", error: "logind went away" } },
		]);
	});

	it("says, and logs, that a command off the plain list spared nothing", async () => {
		interceptorOver([hosted("idle"), me], answering(false, ["hosted"]));

		const verdict = await look("Reboot optimus with `sudo systemctl rescue`");

		expect(verdict).toMatchObject({
			block: true,
			reason: expect.stringMatching(/not all plain/),
		});
		expect(traces()).toMatchObject([{ data: { outcome: "not plain" } }]);
	});

	it("still spares a log-out where only the parked read failed, and says so of a reboot", async () => {
		const spares = async () => ({
			lingers: true,
			parked: new Set<string>(),
			unread: "the host list 7-1.json can't be read",
		});
		interceptorOver([hosted("idle"), me], spares);

		expect(await reply("Please log out of niri on optimus.")).toBeUndefined();
		const verdict = await look("Reboot optimus to install it");

		expect(verdict).toMatchObject({
			block: true,
			reason: expect.stringMatching(
				/the host list 7-1\.json can't be read.*so none was spared/,
			),
		});
		expect(traces().map((entry) => entry.data)).toMatchObject([
			{ outcome: "spared" },
			{ outcome: "unread", error: "the host list 7-1.json can't be read" },
		]);
	});

	it("logs nothing for an ask nothing spared or refused", async () => {
		interceptorOver([me], answering(false));

		await reply("Please reboot optimus.");

		expect(traces()).toEqual([]);
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

	/** A session's presence, as the mesh writes it. */
	const presence = (session: string, state: string) => {
		const dir = join(
			bin,
			"pi",
			"agentic-harness.pi",
			"mesh-workflow",
			"presence",
		);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${session}.json`),
			JSON.stringify({
				session,
				addresses: [session.toUpperCase()],
				groups: ["#all"],
				busy: false,
				state,
			}),
		);
	};

	it("asks logind of this user, and the presences who parked", async () => {
		vi.stubEnv("XDG_STATE_HOME", bin);
		const ran = join(bin, "ran");
		stub(
			"loginctl",
			`echo loginctl >> "${ran}"; [ "$2" = "${userInfo().uid}" ] && echo yes || echo no`,
		);
		stub("busctl", `echo busctl >> "${ran}"; echo "b false"`);
		presence("hosted", "parked");
		presence("woken", "parked");
		presence("waiting", "listening");
		// Each marker from this boot.
		for (const session of ["hosted", "woken"])
			writeParked({
				session,
				sessionFile: `${session}.jsonl`,
				cwd: bin,
				addresses: [session.toUpperCase()],
				parkedAt: new Date().toISOString(),
				pid: process.pid,
				wake: `${session}.wake`,
			});
		// This process's host lists "woken" idle: woken since it parked.
		mkdirSync(stateDir("hosts"), { recursive: true });
		writeFileSync(
			join(stateDir("hosts"), `${process.pid}-1.json`),
			JSON.stringify({
				key: "work-background",
				// Where its start can't be read, the host can't be judged and counts.
				owner: (await ownerNow()) ?? { pid: process.pid, startedAt: 0 },
				sessions: [
					{ id: "woken", state: "idle", since: new Date().toISOString() },
				],
			}),
		);
		const deps = nodeDeps({
			MYCELIUM_REALM: "work",
			PATH: `${bin}:/usr/bin:/bin`,
		});

		expect(await deps.spares?.()).toEqual({
			lingers: true,
			// Where the boot can't be told, as on a Mac, no marker counts.
			parked: machineBooted() === undefined ? new Set() : new Set(["hosted"]),
		});
		expect(
			readFileSync(ran, "utf8").split("\n").filter(Boolean).sort(),
			"the stubs on the PATH it is given answered, not the machine's logind",
		).toEqual(["busctl", "loginctl"]);
	});

	it("says what lingers though the parked sessions can't be read", async () => {
		vi.stubEnv("XDG_STATE_HOME", bin);
		stub("loginctl", `[ "$2" = "${userInfo().uid}" ] && echo yes || echo no`);
		stub("busctl", 'echo "b false"');
		mkdirSync(stateDir("hosts"), { recursive: true });
		writeFileSync(join(stateDir("hosts"), "7-1.json"), "{");
		const deps = nodeDeps({
			MYCELIUM_REALM: "work",
			PATH: `${bin}:/usr/bin:/bin`,
		});

		expect(await deps.spares?.()).toEqual({
			lingers: true,
			parked: new Set(),
			unread: expect.stringMatching(/7-1\.json can't be read/),
		});
	});
});

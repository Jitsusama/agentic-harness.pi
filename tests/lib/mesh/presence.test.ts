/**
 * Presence: what a peer publishes, where it is kept, and what this
 * session's own peer says about itself.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../lib/internal/quest/frontmatter.ts";
import {
	clearRefusedWake,
	writeRefusedWake,
} from "../../../lib/internal/session/refused-wake.ts";
import { localPeer, STEP_MS } from "../../../lib/mesh/peer.ts";
import {
	createPresences,
	type Presence,
	repositoryName,
	windowTitle,
} from "../../../lib/mesh/presence.ts";
import { localDay, noUsage } from "../../../lib/mesh/usage.ts";
import { wantId } from "../../../lib/mesh/want.ts";

let root: string;
const session = "01a15f3a-2255-7463-9909-afa624b025fe";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-presence-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const presence = (over: Partial<Presence> = {}): Presence => ({
	session: "s-1",
	addresses: ["7M6JKG"],
	groups: ["#harness"],
	worksOn: "the mesh",
	owns: ["harness"],
	busy: false,
	at: "2026-10-21T22:00:00.000Z",
	...over,
});

describe("a window's title", () => {
	// windowTitle copies how pi titles its terminal, which pi does not
	// export. Read pi's own source, so a pi upgrade that changes the shape
	// fails here rather than leaving the desktop matching no window.
	const pi = dirname(
		fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
	);
	const source = (path: string) => readFileSync(join(pi, path), "utf8");

	it("is composed as pi composes it, with and without a session name", () => {
		const interactive = source("modes/interactive/interactive-mode.js");
		expect(interactive).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source text under test.
			"setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`)",
		);
		expect(interactive).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source text under test.
			"setTitle(`${APP_TITLE} - ${cwdBasename}`)",
		);
		expect(source("config.js")).toContain(
			'APP_TITLE = piConfigName ? APP_NAME : "\u03c0"',
		);

		expect(windowTitle("Agentic loop", "/home/someone/src/core.nix")).toBe(
			"\u03c0 - Agentic loop - core.nix",
		);
		expect(windowTitle(undefined, "/home/someone/src/core.nix")).toBe(
			"\u03c0 - core.nix",
		);
	});
});

describe("presences", () => {
	it("keep a peer's presence by its session id", () => {
		createPresences(root).publish(presence());

		expect(createPresences(root).of("s-1")).toEqual(presence());
		expect(createPresences(root).of("s-2")).toBeUndefined();
	});

	it("list every peer, passing over one that will not read", () => {
		const presences = createPresences(root);
		presences.publish(presence());
		presences.publish(presence({ session: "s-2", addresses: ["B"] }));
		writeFileSync(join(root, "torn.json"), "{", "utf8");

		expect(
			presences
				.all()
				.map((one) => one.session)
				.sort(),
		).toEqual(["s-1", "s-2"]);
	});

	it("keep the words a window on a hosted conversation runs, only when they are words", () => {
		const view = ["node", "host-join.ts", "--session", "s-1", "--", "pi"];
		const presences = createPresences(root);
		presences.publish(
			presence({
				hosted: { host: "work-attended", conversation: "s-1", view },
			}),
		);
		writeFileSync(
			join(root, "s-2.json"),
			JSON.stringify({
				...presence({ session: "s-2" }),
				hosted: { host: "work-attended", conversation: "s-2", view: [] },
			}),
			"utf8",
		);

		expect(presences.of("s-1")?.hosted?.view).toEqual(view);
		expect(presences.of("s-2")?.hosted).toBeUndefined();
	});

	// As a mycelium node writes a session that runs on another machine.
	it("say which machine a session elsewhere runs on", () => {
		writeFileSync(
			join(root, "s-3.json"),
			JSON.stringify({
				...presence({ session: "s-3" }),
				machine: "equilibrius",
			}),
			"utf8",
		);

		createPresences(root).publish(presence());

		const read = createPresences(root).of("s-3");
		expect(read?.machine).toBe("equilibrius");
		expect(read?.owner).toBeUndefined();
		const here = createPresences(root).of("s-1");
		expect(here?.machine).toBeUndefined();
	});

	it("read a file again only once it has changed", () => {
		const presences = createPresences(root);
		presences.publish(presence());
		const first = presences.all()[0];
		expect(presences.all()[0], "an unchanged file is not parsed again").toBe(
			first,
		);

		presences.publish(presence({ busy: true }));
		expect(presences.all()[0]?.busy, "a publish is read").toBe(true);

		// As another writer does it, in place and inside one clock tick.
		const path = join(root, "s-1.json");
		const at = new Date("2026-11-11T11:00:00Z");
		writeFileSync(path, JSON.stringify(presence({ worksOn: "aaaa" })));
		utimesSync(path, at, at);
		expect(presences.of("s-1")?.worksOn).toBe("aaaa");
		writeFileSync(path, JSON.stringify(presence({ worksOn: "a longer one" })));
		utimesSync(path, at, at);
		expect(presences.of("s-1")?.worksOn, "a size that changed is read").toBe(
			"a longer one",
		);

		rmSync(path);
		expect(presences.all(), "a removed file is gone").toEqual([]);
		expect(presences.of("s-1")).toBeUndefined();
	});

	it("say why a parked peer's host refused its last wake, reading it again only once it changed", () => {
		const presences = createPresences(root);
		const wake = join(root, "a", "wake");
		mkdirSync(dirname(wake), { recursive: true });
		const parked = presence({ state: "parked", wake });
		expect(presences.refusal(parked), "none kept").toBeUndefined();

		const refused = {
			messageId: "2f95756a",
			reason: "the host is stopping",
			at: "2026-11-11T14:00:00.000Z",
		};
		writeRefusedWake(wake, refused);
		const first = presences.refusal(parked);
		expect(first, "the kept refusal").toEqual(refused);
		expect(
			presences.refusal(parked),
			"an unchanged file is not read again",
		).toBe(first);
		expect(
			presences.refusal(presence({ state: "listening", wake })),
			"none for a peer no longer parked",
		).toBeUndefined();

		writeRefusedWake(wake, { ...refused, reason: "the gate said no" });
		expect(presences.refusal(parked)?.reason, "a new refusal is read").toBe(
			"the gate said no",
		);
		clearRefusedWake(wake);
		expect(presences.refusal(parked), "gone once cleared").toBeUndefined();
	});
});

describe("this session's peer", () => {
	const surroundings = () => ({
		session,
		cwd: root,
		records: { sessions: join(root, "sessions"), quests: join(root, "quests") },
		presences: createPresences(join(root, "presence")),
	});

	it("publishes what its quest says it works on and owns", () => {
		mkdirSync(join(root, "sessions"), { recursive: true });
		writeFileSync(
			join(root, "sessions", `${session}.json`),
			JSON.stringify({ quest: "QEST-20261021-LUQ49E" }),
		);
		mkdirSync(join(root, "quests", "QEST-20261021-LUQ49E"), {
			recursive: true,
		});
		writeFileSync(
			join(root, "quests", "QEST-20261021-LUQ49E", "README.md"),
			"---\nid: QEST-20261021-LUQ49E\nkind: quest\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\n---\n# A Stable Substrate\n\n## 📜 Summary\n\nGrow the mesh.\n\n## 🧭 Purpose\n\nWhy.\n",
		);
		const at = surroundings();

		const peer = localPeer(at);
		peer.join("#harness");

		expect(peer.signature).toBe("LUQ49E");
		expect(at.presences.of(session)).toMatchObject({
			addresses: ["LUQ49E", "24B025FE"],
			groups: ["#harness", "#quest/luq49e"],
			joined: ["#harness"],
			worksOn: "A Stable Substrate: Grow the mesh.",
			owns: expect.arrayContaining(["QEST-20261021-LUQ49E", "harness"]),
		});
		// What the launcher draws, said so it reads no README itself.
		expect(at.presences.of(session)).toMatchObject({
			quest: "QEST-20261021-LUQ49E",
			questInfo: {
				id: "QEST-20261021-LUQ49E",
				title: "A Stable Substrate",
				short: "LUQ49E",
				status: "active",
			},
			cwd: root,
		});
	});

	it("says its folder and the repository it is a checkout of, on no quest", () => {
		const main = join(root, "core.nix");
		mkdirSync(join(main, ".git"), { recursive: true });
		writeFileSync(
			join(main, ".git", "config"),
			'[remote "origin"]\n\turl = git@github.com:Jitsusama/core.nix.git\n',
		);
		const at = { ...surroundings(), cwd: main };

		localPeer(at);

		const said = at.presences.of(session);
		expect(said).toMatchObject({ cwd: main, repo: "core.nix" });
		expect(said?.questInfo).toBeUndefined();
	});

	it("reads an older presence with no quest, folder or repository as it was", () => {
		const presences = createPresences(join(root, "presence"));
		presences.publish({
			session,
			addresses: ["24B025FE"],
			groups: [],
			worksOn: "",
			owns: [],
			busy: false,
			at: new Date().toISOString(),
		});

		const read = presences.of(session);
		expect(read?.questInfo).toBeUndefined();
		expect(read?.cwd).toBeUndefined();
		expect(read?.repo).toBeUndefined();
	});

	it("owns its worktree's repository by the repository's name", () => {
		// A worktree's folder is named for the tree broker, which no
		// message about the repository ever mentions.
		const main = join(root, "agentic-harness.pi");
		const tree = join(root, "worktree-github-x-agentic-harness.pi-branch");
		mkdirSync(join(main, ".git", "worktrees", "branch"), { recursive: true });
		mkdirSync(tree, { recursive: true });
		writeFileSync(
			join(main, ".git", "config"),
			'[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:Jitsusama/agentic-harness.pi.git\n',
		);
		writeFileSync(
			join(main, ".git", "worktrees", "branch", "commondir"),
			"../..\n",
		);
		writeFileSync(
			join(tree, ".git"),
			`gitdir: ${join(main, ".git", "worktrees", "branch")}\n`,
		);
		mkdirSync(join(root, "plain"));

		expect(repositoryName(tree)).toBe("agentic-harness.pi");
		expect(repositoryName(main)).toBe("agentic-harness.pi");
		expect(repositoryName(join(root, "plain"))).toBe("plain");
	});

	it("publishes only when something in its presence changed", () => {
		// Presence follows events, never a clock: a peer at rest writes nothing.
		const kept = createPresences(join(root, "presence"));
		const written: Presence[] = [];
		const presences = {
			...kept,
			publish: (one: Presence) => {
				written.push(one);
				kept.publish(one);
			},
		};
		const peer = localPeer({ ...surroundings(), presences });

		peer.refresh();
		peer.refresh();
		peer.setBusy(false);
		expect(written).toHaveLength(1);
		peer.setBusy(true);
		expect(written.map((one) => one.busy)).toEqual([false, true]);
		expect(kept.of(session)).toMatchObject({ busy: true });
	});

	it("names the file its holder wakes it on while it's parked, and not before", () => {
		// 8 November: a node steering a parked session found no wake in its
		// presence, only in the park marker, so it couldn't wake it (KP0L6A).
		const at = surroundings();
		const peer = localPeer(at);
		peer.refresh();
		expect(at.presences.of(session)).not.toHaveProperty("wake");

		peer.park("/run/user/1000/mycelium/work.held/54960192.wake");

		expect(at.presences.of(session)).toMatchObject({
			state: "parked",
			wake: "/run/user/1000/mycelium/work.held/54960192.wake",
		});
	});

	it("says what it is doing: since when a run began, and its step at most every 30 s", () => {
		let clock = Date.parse("2026-10-26T06:00:00Z");
		const at = { ...surroundings(), now: () => clock };
		const peer = localPeer(at);
		const seen = () => at.presences.of(session);

		expect(seen()).toMatchObject({ state: "listening" });
		peer.setBusy(true);
		peer.setStep("bash");
		expect(seen()).toMatchObject({
			state: "busy",
			since: "2026-10-26T06:00:00.000Z",
			step: "bash",
		});

		clock += STEP_MS - 1;
		peer.setStep("edit");
		expect(seen()?.step).toBe("bash");
		clock += 1;
		peer.setStep("edit");
		expect(seen()?.step).toBe("edit");

		peer.setBusy(false);
		expect(seen()).toMatchObject({ state: "listening" });
		expect(seen()?.since).toBeUndefined();
		expect(seen()?.step).toBeUndefined();
	});

	it("says a step begun inside the window once the window ends, unless the run ended first", () => {
		// A long bash begun 5 s after a short read must not read as "read"
		// for the whole of it.
		vi.useFakeTimers();
		try {
			let clock = Date.parse("2026-10-26T06:00:00Z");
			const at = { ...surroundings(), now: () => clock };
			const peer = localPeer(at);
			const step = () => at.presences.of(session)?.step;

			peer.setBusy(true);
			peer.setStep("read");
			clock += 5_000;
			vi.advanceTimersByTime(5_000);
			peer.setStep("bash");
			expect(step()).toBe("read");

			clock += STEP_MS - 5_000;
			vi.advanceTimersByTime(STEP_MS - 5_000);
			expect(step()).toBe("bash");

			clock += 1_000;
			peer.setStep("edit");
			peer.setBusy(false);
			clock += STEP_MS;
			vi.advanceTimersByTime(STEP_MS);
			expect(step()).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("says its step in full: the tool and what it is about, thinking, or waiting on its person", () => {
		vi.useFakeTimers();
		try {
			saysItsStepInFull();
		} finally {
			vi.useRealTimers();
		}
	});

	const saysItsStepInFull = () => {
		let clock = Date.parse("2026-11-06T22:00:00Z");
		const at = { ...surroundings(), now: () => clock };
		const peer = localPeer(at);
		const seen = () => at.presences.of(session);

		peer.setBusy(true);
		peer.setThinking();
		expect(seen()).toMatchObject({
			step: "thinking",
			stepDetail: {
				kind: "thinking",
				name: "",
				detail: "",
				since: "2026-11-06T22:00:00.000Z",
			},
		});

		// Begun inside the window, it is said when the window ends, with
		// the time it began rather than the time it was said.
		clock += 10_000;
		vi.advanceTimersByTime(10_000);
		peer.setStep("bash", "pnpm check");
		expect(seen()?.stepDetail?.kind).toBe("thinking");
		clock += STEP_MS - 10_000;
		vi.advanceTimersByTime(STEP_MS - 10_000);
		expect(seen()).toMatchObject({
			step: "bash",
			stepDetail: {
				kind: "tool",
				name: "bash",
				detail: "pnpm check",
				since: "2026-11-06T22:00:10.000Z",
			},
		});

		peer.want({
			id: wantId("approval", "2026-11-06T22:01:00.000Z"),
			kind: "approval",
			since: "2026-11-06T22:01:00.000Z",
			said: "git push origin main",
		});
		expect(seen()).toMatchObject({
			step: "bash",
			stepDetail: {
				kind: "waiting",
				name: "approval",
				detail: "git push origin main",
				since: "2026-11-06T22:01:00.000Z",
			},
		});

		peer.setBusy(false);
		expect(seen()?.stepDetail).toBeUndefined();
	};

	it("says its usage with the next presence it writes, and carries today's into its next start", () => {
		let clock = Date.parse("2026-11-06T22:00:00");
		const at = { ...surroundings(), now: () => clock };
		const peer = localPeer(at);
		const usage = {
			...noUsage(localDay(new Date(clock))),
			turns: { today: 3 },
			"pi.cost.usd": { last: 0.5, today: 1.25 },
		};

		peer.setBusy(true);
		peer.setUsage(usage);
		expect(at.presences.of(session)?.usage).toBeUndefined();
		peer.setBusy(false);
		expect(at.presences.of(session)?.usage).toEqual(usage);

		expect(localPeer(at).usage).toEqual(usage);

		// Past midnight today's counts start afresh, keeping only a last call.
		clock = Date.parse("2026-11-07T00:01:00");
		expect(localPeer(at).usage).toEqual(noUsage("2026-11-07"));
	});

	it("is paused over all else, and still paused after a reload", () => {
		const at = surroundings();
		const peer = localPeer(at);
		peer.setBusy(true);
		peer.setPaused(true);
		expect(at.presences.of(session)?.state).toBe("paused");

		const reloaded = localPeer(at);
		expect(reloaded.paused, "the peer is still paused after a reload").toBe(
			true,
		);
		reloaded.setPaused(false);
		expect(at.presences.of(session)?.state).toBe("listening");
	});

	it("says a move waiting and what holds it, kept through a reload in its own process alone", () => {
		const at = {
			...surroundings(),
			owner: { pid: 4100, startedAt: 1000 },
		};
		const peer = localPeer(at);
		const moving = {
			to: "background" as const,
			since: "2026-11-10T09:00:00.000Z",
			holds: "background jobs are out",
		};
		peer.setMoving(moving);
		expect(at.presences.of(session)?.moving).toEqual(moving);

		expect(localPeer(at).moving, "a reload goes on waiting").toEqual(moving);
		// The host that takes the file up runs it in another process.
		const adopted = localPeer({
			...at,
			owner: { pid: 5200, startedAt: 2000 },
		});
		expect(adopted.moving, "the adopted conversation moves no more").toBe(
			undefined,
		);
		expect(at.presences.of(session)?.moving).toBeUndefined();
	});

	it("says why a move was called off, until another is asked", () => {
		const at = { ...surroundings(), owner: { pid: 4100, startedAt: 1000 } };
		const peer = localPeer(at);
		peer.setMoving({ to: "attended", since: "2026-11-10T09:00:00.000Z" });
		const off = {
			to: "attended" as const,
			since: "2026-11-10T09:00:00.000Z",
			at: "2026-11-10T09:45:00.000Z",
			why: "it waited 45 minutes and is still held: a fleet is out",
		};
		peer.callOffMove(off);
		expect(at.presences.of(session)?.moving).toBeUndefined();
		expect(at.presences.of(session)?.moveOff).toEqual(off);
		const reloaded = localPeer(at);
		reloaded.refresh();
		expect(
			at.presences.of(session)?.moveOff,
			"a reload still says why",
		).toEqual(off);

		reloaded.setMoving({
			to: "background",
			since: "2026-11-10T10:00:00.000Z",
		});
		expect(at.presences.of(session)?.moveOff).toBeUndefined();
	});

	it("says a person drives it, kept for its own session in any process and passed to no other", () => {
		const at = { ...surroundings(), owner: { pid: 4100, startedAt: 1000 } };
		const peer = localPeer(at);
		expect(at.presences.of(session)?.driven, "said either way").toBe(false);
		peer.setDriven();
		expect(at.presences.of(session)?.driven, "said once a person wrote").toBe(
			true,
		);

		const adopted = localPeer({ ...at, owner: { pid: 5200, startedAt: 2000 } });
		expect(adopted.driven, "the host's conversation says so too").toBe(true);
		const fresh = localPeer({
			...at,
			session: "01a19244-new",
			previous: session,
		});
		expect(fresh.driven, "a new session starts undriven").toBe(false);
	});

	it("reads no move it can't make sense of", () => {
		const presences = createPresences(join(root, "presence"));
		mkdirSync(join(root, "presence"), { recursive: true });
		writeFileSync(
			join(root, "presence", "s-1.json"),
			JSON.stringify({
				...presence(),
				moving: { to: "penelope", since: "2026-11-10T09:00:00.000Z" },
				moveOff: { to: "attended", since: "2026-11-10T09:00:00.000Z" },
			}),
		);
		expect(presences.of("s-1")).not.toHaveProperty("moving");
		expect(presences.of("s-1"), "one saying no why").not.toHaveProperty(
			"moveOff",
		);
	});

	it("is waiting when idle with a want standing, and busy while it runs", () => {
		const at = surroundings();
		const peer = localPeer(at);
		peer.want({
			id: wantId("question", "2026-10-26T06:00:00Z"),
			kind: "question",
			said: "Which launcher?",
			since: "2026-10-26T06:00:00Z",
		});

		expect(at.presences.of(session)?.state).toBe("waiting");
		peer.setBusy(true);
		expect(at.presences.of(session)?.state).toBe("busy");
	});

	it("says its window's title as pi sets it, and the new one after a rename", () => {
		// The desktop finds a peer's window by this exact title, since the
		// title itself no longer carries an address.
		let name: string | undefined;
		const at = {
			...surroundings(),
			title: () => windowTitle(name, "/home/someone/src/core.nix"),
		};
		const peer = localPeer(at);
		expect(at.presences.of(session)?.title).toBe("\u03c0 - core.nix");

		name = "Agentic loop";
		peer.setBusy(true);

		expect(at.presences.of(session)?.title).toBe(
			"\u03c0 - Agentic loop - core.nix",
		);
		expect(createPresences(join(root, "presence")).of(session)?.title).toBe(
			"\u03c0 - Agentic loop - core.nix",
		);
	});

	it("names the terminal window it runs in, as read back from its file", () => {
		// The desktop raises a peer's window by this, since titles can be
		// cut, shared or overridden.
		const terminal = {
			driverId: "kitty",
			kind: "kitty-window",
			hostId: "optimus",
			value: "8",
			scope: "unix:@kitty-318380",
		};
		localPeer({ ...surroundings(), terminal });

		expect(
			createPresences(join(root, "presence")).of(session)?.terminal,
		).toEqual(terminal);
	});

	it("reads a presence whose terminal is malformed as naming none", () => {
		const dir = join(root, "presence");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${presence().session}.json`),
			JSON.stringify({
				...presence(),
				terminal: { driverId: "kitty", value: 8 },
			}),
		);

		expect(
			createPresences(dir).of(presence().session)?.terminal,
		).toBeUndefined();
	});

	it("is in its quest's group, named down from the root, and its repository's", () => {
		const readme = (id: string, parent: string, trees = "") =>
			`---\nid: ${id}\nkind: subquest\nparent: ${parent}\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\n${trees}---\n# ${id}\n`;
		const checkout = join(root, "agentic-harness.pi");
		mkdirSync(join(checkout, ".git"), { recursive: true });
		// A tree taken away since names no repository: its folder's name
		// is the broker's, not the repository's.
		const gone = join(root, "worktree-github-someone-widget-a-branch");
		for (const [id, text] of [
			[
				"QEST-20261021-LUQ49E",
				readme(
					"QEST-20261021-LUQ49E",
					"QEST-20261021-5GV2AH",
					`trees:\n  - path: ${checkout}\n    providerId: git-worktree\n  - path: ${gone}\n    repoRoot: ${gone}\n    providerId: git-worktree\n`,
				),
			],
			[
				"QEST-20261021-5GV2AH",
				readme("QEST-20261021-5GV2AH", "QEST-20261013-4UHC5Q"),
			],
			["QEST-20261013-4UHC5Q", readme("QEST-20261013-4UHC5Q", "null")],
		]) {
			mkdirSync(join(root, "quests", id), { recursive: true });
			writeFileSync(join(root, "quests", id, "README.md"), text);
		}
		mkdirSync(join(root, "sessions"), { recursive: true });
		writeFileSync(
			join(root, "sessions", `${session}.json`),
			JSON.stringify({ quest: "QEST-20261021-LUQ49E" }),
		);

		const peer = localPeer(surroundings());

		expect(peer.scopes).toEqual([
			"#quest/4uhc5q/5gv2ah/luq49e",
			"#repo/agentic-harness-pi",
		]);
		expect(peer.joined).toEqual([]);
	});

	describe("in an orchestration", () => {
		const MISSION = "QEST-20261007-WCJQSG";
		const SWARM = "QEST-20261026-SWARM1";
		const LOOP = "QEST-20261025-QCXZEB";
		const readme = (id: string, parent: string, marked = false) =>
			`---\nid: ${id}\nkind: ${parent === "null" ? "quest" : "subquest"}\nparent: ${parent}\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-25\nupdated: 2026-10-25\n${marked ? "orchestrator: true\n" : ""}---\n# ${id}\n`;
		const write = (quests: [string, string][], loaded: string) => {
			for (const [id, text] of quests) {
				mkdirSync(join(root, "quests", id), { recursive: true });
				writeFileSync(join(root, "quests", id, "README.md"), text);
			}
			mkdirSync(join(root, "sessions"), { recursive: true });
			writeFileSync(
				join(root, "sessions", `${session}.json`),
				JSON.stringify({ quest: loaded }),
			);
		};

		it("sees a parent start orchestrating, though its README kept its old times", () => {
			// A README's parse is kept while the file is unchanged; one written
			// again with its old modification time is still read afresh.
			const long = new Date(Date.now() - 3_600_000);
			const age = (id: string) =>
				utimesSync(join(root, "quests", id, "README.md"), long, long);
			write(
				[
					[MISSION, readme(MISSION, "null")],
					[LOOP, readme(LOOP, MISSION)],
				],
				LOOP,
			);
			age(MISSION);
			age(LOOP);
			const peer = localPeer(surroundings());
			expect(peer.orchestratedBy).toBeUndefined();

			writeFileSync(
				join(root, "quests", MISSION, "README.md"),
				readme(MISSION, "null", true),
			);
			age(MISSION);
			peer.refresh();

			expect(peer.orchestratedBy).toBe("WCJQSG");
		});

		it("joins the orchestration's group and names its orchestrator, found up the tree", () => {
			write(
				[
					[MISSION, readme(MISSION, "null", true)],
					[LOOP, readme(LOOP, MISSION)],
				],
				LOOP,
			);
			const at = surroundings();

			const peer = localPeer(at);

			expect(peer.scopes).toEqual([
				"#orchestration/wcjqsg",
				"#quest/wcjqsg/qcxzeb",
			]);
			expect(peer.orchestratedBy).toBe("WCJQSG");
			expect(peer.orchestrates).toBeUndefined();
			expect(createPresences(join(root, "presence")).of(session)).toMatchObject(
				{ orchestratedBy: "WCJQSG" },
			);
		});

		it("hears only what is put to it while its quest says so", () => {
			write(
				[
					[MISSION, readme(MISSION, "null", true)],
					[LOOP, readme(LOOP, MISSION)],
				],
				LOOP,
			);
			const peer = localPeer(surroundings());
			const before = peer.receiver.hears;
			writeFileSync(
				join(root, "quests", LOOP, "README.md"),
				readme(LOOP, MISSION).replace("---\n#", "hears: addressed\n---\n#"),
			);
			peer.refresh();

			expect(
				[before, peer.receiver.hears, peer.orchestratedBy],
				"everything, then only what is put to it, still orchestrated",
			).toEqual([undefined, "addressed", "WCJQSG"]);
		});

		it("stands at the launcher's top while its quest says so, under the name it gives", () => {
			write([[LOOP, readme(LOOP, "null")]], LOOP);
			const peer = localPeer(surroundings());
			const kept = createPresences(join(root, "presence"));
			const before = Object.keys(kept.of(session) ?? {});
			writeFileSync(
				join(root, "quests", LOOP, "README.md"),
				readme(LOOP, "null").replace(
					"---\n#",
					"stands-at-top: {name: The Void, keywords: [void]}\n---\n#",
				),
			);
			peer.refresh();

			expect(
				[before.includes("standsAtTop"), kept.of(session)?.standsAtTop],
				"left out until its quest says it, then kept as said",
			).toEqual([false, { name: "The Void", keywords: ["void"] }]);
		});

		it("still stands at the top after the workflow rewrites its README", () => {
			const said = readme(LOOP, "null").replace(
				"---\n#",
				"stands-at-top: {name: The Void, keywords: [void]}\n---\n#",
			);
			const parsed = parseQuestFrontMatter(said);
			if (!parsed) throw new Error("the README should parse");
			write(
				[
					[
						LOOP,
						`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
					],
				],
				LOOP,
			);
			localPeer(surroundings());

			expect(
				createPresences(join(root, "presence")).of(session)?.standsAtTop,
			).toEqual({ name: "The Void", keywords: ["void"] });
		});

		it("says what it is for at the top when its quest gives a sentence", () => {
			write(
				[
					[
						LOOP,
						readme(LOOP, "null").replace(
							"---\n#",
							"stands-at-top: {name: The Void, keywords: [void], what: ' Say it once. '}\n---\n#",
						),
					],
				],
				LOOP,
			);
			localPeer(surroundings());

			expect(
				createPresences(join(root, "presence")).of(session)?.standsAtTop,
			).toEqual({ name: "The Void", keywords: ["void"], what: "Say it once." });
		});

		it("stands nowhere when its quest names no one to stand as", () => {
			write(
				[
					[
						LOOP,
						readme(LOOP, "null").replace(
							"---\n#",
							"stands-at-top: {keywords: [void]}\n---\n#",
						),
					],
				],
				LOOP,
			);
			localPeer(surroundings());

			expect(
				Object.keys(createPresences(join(root, "presence")).of(session) ?? {}),
			).not.toContain("standsAtTop");
		});

		it("says the quest it has loaded, by id, and none while it has none", () => {
			write([[LOOP, readme(LOOP, "null")]], LOOP);
			const at = surroundings();

			localPeer(at);

			expect(at.presences.of(session)?.quest).toBe(LOOP);

			writeFileSync(
				join(root, "sessions", `${session}.json`),
				JSON.stringify({}),
			);
			localPeer(at);

			expect(at.presences.of(session)?.quest).toBeUndefined();
		});

		it("keeps a question its run ends on for its orchestrator, and still shows an approval", () => {
			write(
				[
					[MISSION, readme(MISSION, "null", true)],
					[LOOP, readme(LOOP, MISSION)],
				],
				LOOP,
			);
			const peer = localPeer(surroundings());
			const since = new Date(0).toISOString();

			peer.want({
				id: wantId("question", since),
				kind: "question",
				since,
				said: "Shall I merge it?",
			});
			expect(peer.wants).toBeUndefined();

			peer.want({
				id: wantId("approval", since),
				kind: "approval",
				since,
				said: "git push",
			});
			expect(peer.wants).toMatchObject({ kind: "approval" });
		});

		it("lists every want standing, saying the question is its orchestrator's", () => {
			write(
				[
					[MISSION, readme(MISSION, "null", true)],
					[LOOP, readme(LOOP, MISSION)],
				],
				LOOP,
			);
			const at = surroundings();
			const peer = localPeer(at);
			const asked = "2026-11-06T22:00:00.000Z";
			const held = "2026-11-06T22:05:00.000Z";

			peer.want({
				id: wantId("question", asked),
				kind: "question",
				since: asked,
				said: "Shall I merge it?",
			});
			expect(at.presences.of(session)).toMatchObject({
				state: "listening",
				wanting: [{ kind: "question", forPerson: false }],
			});
			expect(at.presences.of(session)?.wants).toBeUndefined();

			peer.want({
				id: wantId("approval", held),
				kind: "approval",
				since: held,
				said: "git push",
			});
			expect(at.presences.of(session)).toMatchObject({
				state: "waiting",
				wants: { kind: "approval" },
				wanting: [
					{
						id: wantId("question", asked),
						kind: "question",
						forPerson: false,
					},
					{ id: wantId("approval", held), kind: "approval", forPerson: true },
				],
			});

			peer.settle("question");
			peer.settle("approval");
			expect(at.presences.of(session)?.wanting).toBeUndefined();
		});

		it("heads its own orchestration as a member of the one above", () => {
			write(
				[
					[MISSION, readme(MISSION, "null", true)],
					[SWARM, readme(SWARM, MISSION, true)],
				],
				SWARM,
			);
			const at = surroundings();

			const peer = localPeer(at);

			expect(peer.scopes).toEqual([
				"#orchestration/swarm1",
				"#orchestration/wcjqsg",
				"#quest/wcjqsg/swarm1",
			]);
			expect(at.presences.of(session)).toMatchObject({
				orchestratedBy: "WCJQSG",
				orchestrates: "SWARM1",
			});
		});

		it("leaves the role to the session already signing with the quest's address", () => {
			write([[MISSION, readme(MISSION, "null", true)]], MISSION);
			const at = surroundings();
			at.presences.publish({
				...presence({
					session: "00000000-0000-0000-0000-000000000001",
					addresses: ["WCJQSG", "00000001"],
				}),
				orchestrates: "WCJQSG",
			});

			const peer = localPeer(at);

			expect(peer.signature).not.toBe("WCJQSG");
			expect(peer.orchestrates).toBeUndefined();
			expect(peer.scopes).toContain("#orchestration/wcjqsg");
		});
	});

	it("is in the repository it runs in, with no quest", () => {
		const checkout = join(root, "core.nix");
		mkdirSync(join(checkout, ".git"), { recursive: true });
		mkdirSync(join(checkout, "modules"));

		const peer = localPeer({
			...surroundings(),
			cwd: join(checkout, "modules"),
		});

		expect(peer.scopes).toEqual(["#repo/core-nix"]);
	});

	it("keeps only what it joined across a reload, and works its scopes out again", () => {
		const at = surroundings();
		at.presences.publish(
			presence({
				session,
				groups: ["#harness", "#quest/old"],
				joined: ["#harness"],
			}),
		);

		const again = localPeer(at);

		expect(again.groups).toEqual(["#harness"]);
	});

	it("keeps its groups across a reload", () => {
		const first = localPeer(surroundings());
		first.join("#optimus/power");

		const again = localPeer(surroundings());

		expect(again.groups).toEqual(["#optimus/power"]);
		expect(
			again.leave("#optimus/power"),
			"leaving a group kept across the reload says it left",
		).toBe(true);
		expect(
			again.leave("#optimus/power"),
			"leaving it a second time says it was not in it",
		).toBe(false);
	});

	it("keeps its stops across a reload, until it lifts them", () => {
		const stop = { address: "P9R1KI", session: "s-p", at: "2026-10-22" };
		const first = localPeer(surroundings());
		expect(first.stop(stop), "a first stop of P9R1KI is taken").toBe(true);
		expect(
			first.stop({ ...stop, why: "again" }),
			"a second stop of P9R1KI is not taken",
		).toBe(false);

		const again = localPeer(surroundings());

		expect(again.stops).toEqual([stop]);
		expect(surroundings().presences.of(session)?.stops).toEqual([stop]);
		expect(again.lift("P9R1KI")).toEqual(stop);
		expect(again.lift("P9R1KI")).toBeUndefined();
		expect(localPeer(surroundings()).stops).toEqual([]);
		expect(surroundings().presences.of(session)?.stops).toBeUndefined();
	});

	it("says what it waits on its person for, longest first, until each is settled", () => {
		const peer = localPeer(surroundings());
		const asked = {
			id: wantId("question", "2026-10-22T08:00:00.000Z"),
			kind: "question" as const,
			since: "2026-10-22T08:00:00.000Z",
			said: "Which launcher?",
		};
		const held = {
			id: wantId("approval", "2026-10-22T07:50:00.000Z"),
			kind: "approval" as const,
			since: "2026-10-22T07:50:00.000Z",
			said: "Push to main?",
		};
		const kept = () => surroundings().presences.of(session)?.wants;

		peer.want(asked);
		expect(kept()).toEqual(asked);
		peer.want(held);
		expect(kept()).toEqual(held);
		expect(peer.settle("approval"), "the standing approval is settled").toBe(
			true,
		);
		expect(kept()).toEqual(asked);
		expect(peer.settle("approval"), "no approval is left to settle").toBe(
			false,
		);
		expect(peer.settle("question"), "the standing question is settled").toBe(
			true,
		);
		expect(kept()).toBeUndefined();
	});

	it("waits on nothing after a start, whatever its presence said", () => {
		const peer = localPeer(surroundings());
		peer.want({
			id: wantId("blocked", "2026-10-22T08:00:00.000Z"),
			kind: "blocked",
			since: "2026-10-22T08:00:00.000Z",
			said: "Blocked: needs Joel's say on the launcher",
		});

		const again = localPeer(surroundings());

		expect(again.wants).toBeUndefined();
		expect(surroundings().presences.of(session)?.wants).toBeUndefined();
	});

	describe("what it landed", () => {
		const noon = Date.parse("2026-11-01T12:00:00.000Z");
		const at = (minutes: number) =>
			new Date(noon + minutes * 60_000).toISOString();
		const landing = (ref: string, minutes = 0) => ({
			at: at(minutes),
			ref,
			what: `${ref} landed`,
		});
		const clocked = (over: { session?: string; previous?: string } = {}) => ({
			...surroundings(),
			...over,
			now: () => noon + 60 * 60_000,
		});

		it("publishes each landing, newest first, one per ref", () => {
			const peer = localPeer(clocked());

			peer.landed(landing("agentic-harness.pi#920", 0));
			peer.landed(landing("core.nix#1491", 5));
			peer.landed({ ...landing("agentic-harness.pi#920", 10), what: "again" });

			expect(
				surroundings()
					.presences.of(session)
					?.landings?.map((one) => one.ref),
			).toEqual(["agentic-harness.pi#920", "core.nix#1491"]);
			expect(peer.landings[0]?.what).toBe("again");
		});

		it("keeps them across a reload and into the log a rollover starts", () => {
			localPeer(clocked()).landed(landing("PLAN-20261030-QMUYBH#14a"));

			expect(localPeer(clocked()).landings.map((one) => one.ref)).toEqual([
				"PLAN-20261030-QMUYBH#14a",
			]);
			const rolled = localPeer(
				clocked({ session: "01a19244-rolled", previous: session }),
			);
			expect(rolled.landings.map((one) => one.ref)).toEqual([
				"PLAN-20261030-QMUYBH#14a",
			]);
		});

		it("lets one older than a day go at its next start", () => {
			localPeer(clocked()).landed(landing("core.nix#1400", -25 * 60));

			expect(localPeer(clocked()).landings).toEqual([]);
		});
	});
});

describe("a presence's landings, read back", () => {
	it("keep the well-formed ones and drop what isn't one", () => {
		const good = {
			at: "2026-11-01T12:00:00.000Z",
			ref: "core.nix#1",
			what: "x",
		};
		writeFileSync(
			join(root, "s-1.json"),
			JSON.stringify({
				...presence(),
				landings: [good, { ref: "no time" }, "text", { ...good, person: 3 }],
			}),
		);

		expect(createPresences(root).of("s-1")?.landings).toEqual([good]);
	});

	it("are left out when there are none", () => {
		writeFileSync(
			join(root, "s-1.json"),
			JSON.stringify({ ...presence(), landings: [] }),
		);

		expect(createPresences(root).of("s-1")).not.toHaveProperty("landings");
	});
});

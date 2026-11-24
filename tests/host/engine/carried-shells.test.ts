import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
} from "vitest";
import {
	type CarriedShellsOptions,
	carriedShells,
	KEPT_FILE,
	type KeptCall,
	STRAY_FOR_MS,
	STRAY_LOOK_MS,
} from "../../../host/engine/carried-shells.ts";
import type { ProcessTable } from "../../../host/engine/tool-children.ts";
import { HOST_RESTARTING_EVENT } from "../../../lib/core/session/host.ts";
import type { CarriedShell } from "../../../lib/internal/shell/carried.ts";
import type { KeptJob } from "../../../lib/internal/shell/kept-jobs.ts";
import { CALL_VARIABLE } from "../../../lib/internal/shell/reap.ts";
import { JOBS_CARRIED, type JobsCarried } from "../../../lib/jobs/host.ts";
import { execed } from "../../support/processes.ts";

const OWN = "/user.slice/user@1000.service/agents.slice/pi-host.service";
const OWN_CGROUP = `0::${OWN}\n`;
const JOBS_PROCS =
	"/sys/fs/cgroup/user.slice/user@1000.service/jobs.slice/jobs.service/cgroup.procs";
const SELF = 100;

interface Process {
	readonly cgroup: string;
	readonly environ: Record<string, string>;
}

function table(processes: Record<number, Process>): ProcessTable {
	return {
		self: SELF,
		pids: () => [SELF, ...Object.keys(processes).map(Number)],
		environ: async (pid) =>
			pid === SELF ? {} : (processes[pid]?.environ ?? undefined),
		group: () => undefined,
		cgroup: (pid) => (pid === SELF ? OWN : processes[pid]?.cgroup),
		started: () => undefined,
		kill: () => {},
	};
}

function shell(mark: string, extra: Partial<CarriedShell> = {}): CarriedShell {
	return {
		kind: "shell",
		keep: `/kept/${mark}`,
		pid: 200,
		mark,
		startedAt: 0,
		...extra,
	};
}

function bus() {
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	return {
		on(channel: string, listener: (data: unknown) => void) {
			listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((each) => each !== listener),
				);
			};
		},
		emit(channel: string, data: unknown) {
			for (const listener of listeners.get(channel) ?? []) listener(data);
		},
	};
}

function carriedOn(session: string, work: CarriedShell): JobsCarried {
	return {
		session,
		jobs: [{ id: "j1", kind: "shell", label: "make test", work }],
	};
}

describe("carried shells", () => {
	let stateDir: string;
	let moved: [string, number][];
	let said: string[];
	let reported: unknown[];
	let stopped: CarriedShell[];
	let now: number;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "carried-shells-"));
		moved = [];
		said = [];
		reported = [];
		stopped = [];
		now = 1_000_000;
	});
	afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

	function make(
		overrides: Partial<CarriedShellsOptions> = {},
	): ReturnType<typeof carriedShells> {
		return carriedShells({
			stateDir,
			jobs: "jobs.slice/jobs.service",
			ownCgroup: () => OWN_CGROUP,
			scoped: false,
			recorded: () => [],
			table: table({}),
			move: async (procs, pid) => {
				moved.push([procs, pid]);
			},
			running: () => true,
			stop: (work) => stopped.push(work),
			say: (line) => said.push(line),
			report: (error) => reported.push(error),
			now: () => now,
			...overrides,
		});
	}

	function kept(): KeptCall[] {
		return JSON.parse(readFileSync(join(stateDir, KEPT_FILE), "utf8"));
	}

	it("never kills a carried call's group by its pid alone where there is no process table, as on a Mac", async () => {
		// A real process carrying the call's mark, so the host's own
		// judgement finds it the call wherever it can read its environment.
		const call = spawn("sleep", ["30"], {
			env: { ...process.env, [CALL_VARIABLE]: "m1" },
			stdio: "ignore",
		});
		await once(call, "spawn");
		onTestFinished(() => {
			call.kill("SIGKILL");
		});
		// Its mark reads empty until its exec has laid it out.
		await execed(call.pid ?? 0, "sleep");
		const due: KeptCall = {
			session: "s1",
			job: "j1",
			label: "make test",
			at: 0,
			work: shell("m1", { pid: call.pid ?? 0 }),
		};
		now = STRAY_FOR_MS + 1;
		const write = () =>
			writeFileSync(join(stateDir, KEPT_FILE), `${JSON.stringify([due])}\n`);
		// The host's own judgement of running, not this file's stand-in.
		write();
		await make({ running: undefined }).look(() => false);
		expect(stopped, "where /proc is, the pid and its mark say").toHaveLength(1);

		stopped = [];
		write();
		await make({
			running: undefined,
			table: { ...table({}), absent: () => true, pids: () => [] },
		}).look(() => false);
		expect(stopped, "no group is killed on a pid's word alone").toEqual([]);
		expect(kept(), "the record is let go").toEqual([]);
	});

	it("keeps nothing where there is no jobs cgroup", () => {
		expect(
			make({ jobs: "" }).keeps,
			"a host with no jobs cgroup keeps nothing",
		).toBe(false);
		expect(make().keeps, "a host with a jobs cgroup keeps calls").toBe(true);
	});

	it("keeps calls with no jobs cgroup where its spawners run in scopes of their own", async () => {
		expect(
			make({ jobs: "", scoped: false }).keeps,
			"the same host without scopes keeps nothing",
		).toBe(false);
		const shells = make({ jobs: "", scoped: true });
		expect(shells.keeps, "a host whose spawners have scopes keeps calls").toBe(
			true,
		);
		const events = bus();
		shells.heard(events);
		events.emit(HOST_RESTARTING_EVENT, { session: "s1" });
		events.emit(JOBS_CARRIED, carriedOn("s1", shell("m1")));
		expect(await shells.keep(), "nothing to move out of the unit").toEqual([]);
		expect(moved, "no cgroup to move into").toEqual([]);
		expect(
			kept().map((call) => call.job),
			"written down for the next host",
		).toEqual(["j1"]);
	});

	it("keeps a park's calls in a child only where its spawners have scopes, and in a shared host as its stop would", () => {
		expect(
			make({ scoped: false }).keepsThroughPark(true),
			"a child's unit ends with its park, jobs cgroup or not",
		).toBe(false);
		expect(
			make({ jobs: "", scoped: true }).keepsThroughPark(true),
			"a child whose spawners have scopes",
		).toBe(true);
		expect(
			make({ scoped: false }).keepsThroughPark(false),
			"a shared host moves them into the jobs cgroup at its stop",
		).toBe(true);
		expect(
			make({ jobs: "", scoped: false }).keepsThroughPark(false),
			"nowhere to keep them",
		).toBe(false);
	});

	it("moves only the processes in its own cgroup that carry the call's mark", async () => {
		const shells = make({
			table: table({
				201: { cgroup: OWN, environ: { PI_BASH_CALL: "m1" } },
				202: { cgroup: OWN, environ: { PI_BASH_CALL: "m2" } },
				203: {
					cgroup: "/user.slice/user@1000.service/jobs.slice/jobs.service",
					environ: { PI_BASH_CALL: "m1" },
				},
				204: { cgroup: OWN, environ: { PATH: "/bin" } },
			}),
		});
		const conversation = bus();
		shells.heard(conversation);
		conversation.emit(HOST_RESTARTING_EVENT, { session: "s1" });
		conversation.emit(JOBS_CARRIED, carriedOn("s1", shell("m1")));

		expect(await shells.keep()).toEqual([201]);
		expect(moved).toEqual([[JOBS_PROCS, 201]]);
		expect(kept()).toEqual([
			expect.objectContaining({ session: "s1", job: "j1", at: now }),
		]);
	});

	// A park's stop tells the conversation of a restart, so its carry is
	// heard here, and every carrying park adds to the list (#1981).
	it("keeps through its own stop the calls each park carried that still run, and drops those that ended", async () => {
		const ended = new Set<string>();
		const shells = make({
			running: (work) => !ended.has(work.mark),
			table: table({
				201: { cgroup: OWN, environ: { PI_BASH_CALL: "m1" } },
				202: { cgroup: OWN, environ: { PI_BASH_CALL: "m2" } },
			}),
		});
		for (const [session, mark] of [
			["s1", "m1"],
			["s2", "m2"],
			["s3", "m3"],
		] as const) {
			const parked = bus();
			shells.heard(parked);
			parked.emit(HOST_RESTARTING_EVENT, { session });
			parked.emit(JOBS_CARRIED, carriedOn(session, shell(mark)));
		}
		ended.add("m2");
		ended.add("m3");

		expect(await shells.keep(), "only the call still out moves").toEqual([201]);
		expect(kept().map((call) => call.session)).toEqual(["s1"]);
	});

	// A call's end read off the thread can fail for a moment, as on
	// EMFILE; a restart then keeps the call rather than drop one still out.
	it("keeps through its own stop a call whose end can't be read for the moment", async () => {
		const shells = make({
			running: () => Promise.reject(new Error("EMFILE reading the end")),
			table: table({ 201: { cgroup: OWN, environ: { PI_BASH_CALL: "m1" } } }),
		});
		const parked = bus();
		shells.heard(parked);
		parked.emit(HOST_RESTARTING_EVENT, { session: "s1" });
		parked.emit(JOBS_CARRIED, carriedOn("s1", shell("m1")));

		expect(await shells.keep()).toEqual([201]);
		expect(kept().map((call) => call.session)).toEqual(["s1"]);
	});

	// An earlier restart's list that can't be read for the moment, as on
	// EMFILE, would be lost if written over unread; this restart's calls
	// are still recorded as they run, for a later host's look.
	it("writes no kept list over one it can't read for the moment, saying so", async () => {
		const file = join(stateDir, KEPT_FILE);
		const earlier: KeptCall = {
			session: "s0",
			job: "j0",
			label: "make old",
			at: now,
			work: shell("m0"),
		};
		writeFileSync(file, JSON.stringify([earlier]));
		chmodSync(file, 0o000);
		onTestFinished(() => chmodSync(file, 0o600));
		const shells = make({
			table: table({ 201: { cgroup: OWN, environ: { PI_BASH_CALL: "m1" } } }),
		});
		const parked = bus();
		shells.heard(parked);
		parked.emit(HOST_RESTARTING_EVENT, { session: "s1" });
		parked.emit(JOBS_CARRIED, carriedOn("s1", shell("m1")));

		expect(await shells.keep(), "its call still moves").toEqual([201]);
		chmodSync(file, 0o600);
		expect(kept(), "the earlier list as it was").toEqual([earlier]);
		expect(String(reported[0]), "why nothing was kept").toContain(
			"couldn't be read for the moment",
		);
	});

	// Its new holder takes the calls up, so this host's restart must
	// neither keep them nor, a day on, stop them (#1981 F29).
	it("keeps nothing of a conversation released to another holder", async () => {
		const shells = make({
			table: table({
				201: { cgroup: OWN, environ: { PI_BASH_CALL: "m1" } },
				202: { cgroup: OWN, environ: { PI_BASH_CALL: "m2" } },
			}),
		});
		for (const [session, mark] of [
			["s1", "m1"],
			["s2", "m2"],
		] as const) {
			const parked = bus();
			shells.heard(parked);
			parked.emit(HOST_RESTARTING_EVENT, { session });
			parked.emit(JOBS_CARRIED, carriedOn(session, shell(mark)));
		}
		shells.released("s1");

		expect(await shells.keep()).toEqual([202]);
		expect(kept().map((call) => call.session)).toEqual(["s2"]);
	});

	it("keeps nothing a conversation carried away when no restart was said to it", async () => {
		const shells = make({
			table: table({ 201: { cgroup: OWN, environ: { PI_BASH_CALL: "m1" } } }),
		});
		const conversation = bus();
		shells.heard(conversation);
		conversation.emit(JOBS_CARRIED, carriedOn("s1", shell("m1")));

		expect(await shells.keep()).toEqual([]);
		expect(moved).toEqual([]);
	});

	it("goes on past a process that ended as it was moved", async () => {
		const shells = make({
			table: table({ 201: { cgroup: OWN, environ: { PI_BASH_CALL: "m1" } } }),
			move: async () => {
				throw Object.assign(new Error("gone"), { code: "ESRCH" });
			},
		});
		const conversation = bus();
		shells.heard(conversation);
		conversation.emit(HOST_RESTARTING_EVENT, { session: "s1" });
		conversation.emit(JOBS_CARRIED, carriedOn("s1", shell("m1")));

		expect(await shells.keep()).toEqual([]);
		expect(reported).toEqual([]);
		expect(kept()).toHaveLength(1);
	});

	describe("watching what an earlier restart kept", () => {
		function keptEarlier(...calls: KeptCall[]): void {
			writeFileSync(join(stateDir, KEPT_FILE), JSON.stringify(calls));
		}

		function watched(
			holds: (session: string) => boolean,
			overrides: Partial<CarriedShellsOptions> = {},
		): () => Promise<void> {
			let look: (() => void | Promise<void>) | undefined;
			make({
				every: (ms, run) => {
					expect(ms).toBe(STRAY_LOOK_MS);
					look = run;
					return () => {};
				},
				...overrides,
			}).watch(holds);
			return async () => {
				await look?.();
			};
		}

		const call = (work: CarriedShell): KeptCall => ({
			session: "s1",
			job: "j1",
			label: "make test",
			at: 1_000_000,
			work,
		});

		it("leaves a call that isn't due yet", async () => {
			keptEarlier(call(shell("m1")));
			const look = watched(() => false);
			now += STRAY_FOR_MS - 1;
			await look();
			expect(stopped).toEqual([]);
			expect(kept()).toHaveLength(1);
		});

		it("stops a call nobody took up a day after the restart, saying so", async () => {
			keptEarlier(call(shell("m1")));
			const look = watched(() => false);
			now += STRAY_FOR_MS;
			await look();
			expect(stopped).toEqual([shell("m1")]);
			expect(said).toEqual([
				expect.stringMatching(/make test.*j1 of s1.*a day passed/),
			]);
			expect(kept()).toEqual([]);
		});

		it("stops one sooner once its time limit passes", async () => {
			keptEarlier(call(shell("m1", { deadline: 1_000_000 + 60_000 })));
			const look = watched(() => false);
			now += 60_000;
			await look();
			expect(stopped).toHaveLength(1);
			expect(said).toEqual([expect.stringMatching(/its time limit passed/)]);
		});

		describe("a call recorded as it ran, whose pi has gone", () => {
			const stray = (work: CarriedShell, session = "s1"): KeptJob => ({
				session,
				id: "j1",
				kind: "bash",
				label: "make test",
				work,
			});

			it("is left until a day from its start", async () => {
				const work = shell("m1", { startedAt: now });
				const look = watched(() => false, { recorded: () => [stray(work)] });
				now += STRAY_FOR_MS - 1;
				await look();
				expect(stopped).toEqual([]);
			});

			it("is stopped a day from its start, saying so", async () => {
				const work = shell("m1", { startedAt: now });
				const look = watched(() => false, { recorded: () => [stray(work)] });
				now += STRAY_FOR_MS;
				await look();
				expect(stopped).toEqual([work]);
				expect(said).toEqual([
					expect.stringMatching(/make test.*j1 of s1.*recorded.*a day passed/),
				]);
			});

			it("is stopped sooner once its time limit passes", async () => {
				const work = shell("m1", { startedAt: now, deadline: now + 60_000 });
				const look = watched(() => false, { recorded: () => [stray(work)] });
				now += 60_000;
				await look();
				expect(stopped).toEqual([work]);
				expect(said).toEqual([expect.stringMatching(/its time limit passed/)]);
			});

			// The kept folder is read off the thread the host's conversations
			// share, so what jobs recorded comes back later.
			it("is stopped once the folder's reading comes back", async () => {
				const work = shell("m1", { startedAt: now });
				const look = watched(() => false, {
					recorded: async () => [stray(work)],
				});
				now += STRAY_FOR_MS;
				await look();
				expect(stopped).toEqual([work]);
			});

			it("is stopped once, however long the folder takes to read", async () => {
				const work = shell("m1", { startedAt: now });
				const readings: ((jobs: KeptJob[]) => void)[] = [];
				const look = watched(() => false, {
					recorded: () =>
						new Promise<KeptJob[]>((done) => {
							readings.push(done);
						}),
				});
				now += STRAY_FOR_MS;
				const first = look();
				const second = look();
				for (const answer of readings) answer([stray(work)]);
				await Promise.all([first, second]);
				expect(stopped, "a tick during a look waits for the next").toEqual([
					work,
				]);
			});

			it("is looked at again once a look has ended", async () => {
				const work = shell("m1", { startedAt: now });
				let reads = 0;
				const look = watched(() => false, {
					recorded: async () => {
						reads += 1;
						return [stray(work)];
					},
				});
				await look();
				expect(stopped, "not due at the first look").toEqual([]);
				now += STRAY_FOR_MS;
				await look();
				expect(reads, "each tick after a look reads again").toBe(2);
				expect(stopped).toEqual([work]);
			});

			it("is looked at again after a look fails, which is reported", async () => {
				const work = shell("m1", { startedAt: now });
				const failure = new Error("EIO reading the kept folder");
				let reads = 0;
				const look = watched(() => false, {
					recorded: async () => {
						reads += 1;
						if (reads === 1) throw failure;
						return [stray(work)];
					},
				});
				now += STRAY_FOR_MS;
				await look();
				expect(reported).toEqual([failure]);
				await look();
				expect(stopped, "the next tick looks as if none failed").toEqual([
					work,
				]);
			});

			it("says once that a look has not come back by the next tick", async () => {
				const look = watched(() => false, {
					recorded: () => new Promise<KeptJob[]>(() => {}),
				});
				void look();
				void look();
				void look();
				await Promise.resolve();
				expect(reported).toEqual([
					expect.objectContaining({
						message: expect.stringMatching(/has not come back/),
					}),
				]);
			});

			it("says it again of a later look that sticks, once the first came back", async () => {
				let cameBack: (jobs: KeptJob[]) => void = () => undefined;
				const looks = [
					new Promise<KeptJob[]>((resolve) => {
						cameBack = resolve;
					}),
					new Promise<KeptJob[]>(() => undefined),
				];
				const look = watched(() => false, {
					recorded: () => looks.shift() ?? [],
				});
				const first = look();
				void look();
				cameBack([]);
				// The first look reads the kept file off the thread once its
				// folder comes back, so it is waited out, finally and all.
				await first;
				void look();
				void look();
				expect(
					reported.map((error) =>
						error instanceof Error ? error.message : error,
					),
					"each look that sticks is said",
				).toEqual([
					expect.stringMatching(/has not come back/),
					expect.stringMatching(/has not come back/),
				]);
			});

			it("is left to a conversation here that holds it, or once it ended", async () => {
				const held = shell("m1", { startedAt: 0 });
				const ended = shell("m2", { startedAt: 0 });
				const look = watched((session) => session === "s1", {
					recorded: () => [stray(held), stray(ended, "s2")],
					running: (work) => work.mark !== "m2",
				});
				now += STRAY_FOR_MS;
				await look();
				expect(stopped).toEqual([]);
			});
		});

		it("neither stops nor lets go of a call whose end can't be read for the moment", async () => {
			keptEarlier(call(shell("m1")));
			const look = watched(() => false, {
				running: () => Promise.reject(new Error("EMFILE reading the end")),
			});
			now += STRAY_FOR_MS;
			await look();
			expect(stopped).toEqual([]);
			expect(kept()).toHaveLength(1);
		});

		it("never stops a recorded call whose end can't be read for the moment", async () => {
			const work = shell("m1", { startedAt: now });
			const look = watched(() => false, {
				recorded: () => [
					{ session: "s1", id: "j1", kind: "bash", label: "make test", work },
				],
				running: () => Promise.reject(new Error("EMFILE reading the end")),
			});
			now += STRAY_FOR_MS;
			await look();
			expect(stopped).toEqual([]);
		});

		// The look and a restart's keep each read the kept file and write it
		// back off the thread; unserialised, the look's older list would
		// write over the call the keep had just added. A host's stop waits
		// on its keep, so the keep never waits on the look's reads.
		it("keeps what a restart adds while a look is still reading, without waiting for it", async () => {
			keptEarlier({ ...call(shell("m0")), session: "s0" });
			let asked: () => void = () => undefined;
			const reading = new Promise<void>((resolve) => {
				asked = resolve;
			});
			let answer: (running: boolean) => void = () => undefined;
			let look: (() => void | Promise<void>) | undefined;
			const shells = make({
				every: (_ms, run) => {
					look = run;
					return () => {};
				},
				table: table({ 201: { cgroup: OWN, environ: { PI_BASH_CALL: "m1" } } }),
				running: (work) => {
					if (work.mark !== "m0") return true;
					asked();
					return new Promise<boolean>((resolve) => {
						answer = resolve;
					});
				},
			});
			shells.watch(() => false);
			const parked = bus();
			shells.heard(parked);
			parked.emit(HOST_RESTARTING_EVENT, { session: "s1" });
			parked.emit(JOBS_CARRIED, carriedOn("s1", shell("m1")));
			now += STRAY_FOR_MS;

			const looking = look?.();
			await reading;
			expect(await shells.keep(), "kept as the look reads").toEqual([201]);
			expect(
				kept().map((each) => each.session),
				"the earlier call and the restart's",
			).toEqual(["s0", "s1"]);
			answer(true);
			await looking;

			expect(stopped).toEqual([shell("m0")]);
			expect(kept().map((each) => each.session)).toEqual(["s1"]);
		});

		it("lets go of a call a conversation here holds, or that ended", async () => {
			keptEarlier(
				call(shell("m1")),
				{ ...call(shell("m2")), session: "s2" },
				{ ...call(shell("m3")), session: "s3" },
			);
			const look = watched((session) => session === "s1", {
				running: (work) => work.mark !== "m2",
			});
			await look();
			expect(stopped).toEqual([]);
			expect(kept().map((each) => each.session)).toEqual(["s3"]);
		});
	});
});

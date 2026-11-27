import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	baseTip,
	DEFAULT_GATE_MINUTES,
	gateFor,
	gateRefusal,
	gateRunner,
	MOST_GATE_MINUTES,
	type RunGate,
} from "../../../../extensions/review-integration/merge-gate.ts";
import { withCallSignal } from "../../../../lib/core/exec/index.ts";

const CORE = "github:Jitsusama/core.nix";
const HEAD = "4dca0632e1f0a6b3c9d27f4e5a8b1c0d2e3f4a5b";
const review = { merge: { gates: { [CORE]: "merge-net ready" } } };
const GATE = { command: "merge-net ready", minutes: DEFAULT_GATE_MINUTES };

/** A gate run that never runs: it only keeps the time it was given. */
function timed(): { run: RunGate; given: number[] } {
	const given: number[] = [];
	return {
		given,
		run: async (_line, _cwd, timeoutMs) => {
			given.push(timeoutMs);
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
	};
}

/** The gate run by a real shell, as review_offer runs it. */
const shell: RunGate = gateRunner();

/** How long a test waits for a gate to speak before failing, well short of a 10 s clock. */
const SPEAKS_MS = 8_000;

/**
 * A clock that fires only once the gate's bash has started and run its
 * first lines, even on a loaded machine; the test waits past it.
 */
const STARTS_MS = 3_000;

/** Resolves once `path` is there, or fails after SPEAKS_MS. */
async function until(path: string, what: string): Promise<void> {
	await vi.waitFor(
		() => {
			if (!existsSync(path)) throw new Error(`${what} hasn't happened yet`);
		},
		{ timeout: SPEAKS_MS, interval: 20 },
	);
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// 8 November: four checks went red on core.nix's main, each named by
// changed-checks at its merge, from branches that built before rebasing.
describe("where a merge's base is", () => {
	/** A runner that answers every line as `ran` says. */
	const answering =
		(ran: Partial<Awaited<ReturnType<RunGate>>>): RunGate =>
		async () => ({ code: 1, stdout: "", stderr: "", killed: false, ...ran });
	const CHECKOUT = "name a checkout of the repo with `repo`";

	it("sends a folder git can't read origin in to a named checkout", async () => {
		const read = await baseTip(
			"main",
			"/nowhere",
			answering({ code: 128, stderr: "fatal: not a git repository" }),
		);
		expect(read, "what git said, and the checkout to name").toEqual({
			unread:
				"git ls-remote origin refs/heads/main gave exit 128: fatal: not a git repository",
			fix: CHECKOUT,
		});
	});

	it("names no checkout for what a checkout wouldn't mend", async () => {
		const cases = [
			["a change with no base", "", answering({ code: 0 })],
			["origin past its time", "main", answering({ code: 124, killed: true })],
			["a stopped call", "main", answering({ code: 130, aborted: true })],
		] as const;
		for (const [what, base, run] of cases) {
			const read = await baseTip(base, "/nowhere", run);
			expect("fix" in read ? read.fix : "read", `${what}: some fix`).not.toBe(
				"read",
			);
			expect("fix" in read ? read.fix : "", `${what}: not a checkout`).not.toBe(
				CHECKOUT,
			);
		}
	});
});

describe("a repo's merge gate", () => {
	it("is read by the repo's key, and none for a repo that names none", () => {
		expect(
			gateFor(review, CORE),
			"a bare command gets the default time",
		).toEqual({
			kind: "gate",
			command: "merge-net ready",
			minutes: DEFAULT_GATE_MINUTES,
		});
		expect(
			gateFor(review, "github:Jitsusama/agentic-harness.pi"),
			"a repo naming no gate has none",
		).toEqual({ kind: "none" });
		expect(gateFor(undefined, CORE), "no review section names no gate").toEqual(
			{
				kind: "none",
			},
		);
	});

	it("gives a bare command five minutes, and runs it with that long", async () => {
		const gate = gateFor(review, CORE);
		if (gate.kind !== "gate") throw new Error("no gate was read");
		const { run, given } = timed();
		await gateRefusal(gate, HEAD, dir, run);
		expect(given, "a bare command is killed after five minutes").toEqual([
			5 * 60_000,
		]);
	});

	it("takes the shortest and the longest time a gate may name", () => {
		for (const minutes of [1, 180]) {
			expect(
				gateFor(
					{ merge: { gates: { [CORE]: { command: "x", minutes } } } },
					CORE,
				),
				`minutes of ${minutes} is a time a gate may name`,
			).toEqual({ kind: "gate", command: "x", minutes });
		}
	});

	it("accepts a queued base only on a forge whose queue lands the change", () => {
		// 23 November: World's main moved 40 times in 140 seconds, so a
		// gate that compared it before and after refused nearly every merge.
		const WORLD = "delta:shop/world";
		const queued = (repo: string, base: unknown) =>
			gateFor({ merge: { gates: { [repo]: { command: "x", base } } } }, repo);
		expect(queued(WORLD, "queued"), "Delta's queue lands it").toEqual({
			kind: "gate",
			command: "x",
			minutes: DEFAULT_GATE_MINUTES,
			queued: true,
		});
		expect(
			queued(WORLD, undefined),
			"a gate naming no base has it read, on any forge",
		).toEqual({ kind: "gate", command: "x", minutes: DEFAULT_GATE_MINUTES });
		expect(
			queued(CORE, "queued"),
			"a forge not known to queue every change has its base read",
		).toMatchObject({
			kind: "malformed",
			problem: expect.stringContaining(
				"github isn't known here to land every change through a queue",
			),
		});
		expect(
			queued(WORLD, "unread"),
			"a base that isn't queued is refused, naming it",
		).toMatchObject({
			kind: "malformed",
			problem: expect.stringContaining('may only be "queued", not "unread"'),
		});
	});

	it("refuses a key a gate doesn't read, so a misspelt time isn't the default", () => {
		expect(
			gateFor(
				{ merge: { gates: { [CORE]: { command: "x", minuets: 30 } } } },
				CORE,
			),
			"a misspelt minutes is refused, naming it",
		).toMatchObject({
			kind: "malformed",
			problem: expect.stringContaining('"minuets"'),
		});
	});

	it("gives a gate the minutes it names, and runs it with that long", async () => {
		// 21 November: core.nix's merge-net ready took about 13 minutes,
		// past the five every gate had, so no core.nix PR could merge
		// through review_offer (1JQPPC, CUITX1).
		const slow = {
			merge: { gates: { [CORE]: { command: "merge-net ready", minutes: 30 } } },
		};
		const gate = gateFor(slow, CORE);
		expect(gate, "the gate keeps its command and its own time").toEqual({
			kind: "gate",
			command: "merge-net ready",
			minutes: 30,
		});
		if (gate.kind !== "gate") throw new Error("no gate was read");
		const { run, given } = timed();
		await gateRefusal(gate, HEAD, dir, run);
		expect(given, "the run is killed only after the gate's 30 minutes").toEqual(
			[30 * 60_000],
		);
	});

	it("refuses a time it can't trust, so the merge stops", () => {
		for (const minutes of [
			0,
			2.5,
			-1,
			"30",
			MOST_GATE_MINUTES + 1,
			null,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			true,
		]) {
			expect(
				gateFor(
					{ merge: { gates: { [CORE]: { command: "x", minutes } } } },
					CORE,
				),
				`minutes of ${JSON.stringify(minutes)} is refused`,
			).toMatchObject({
				kind: "malformed",
				problem: expect.stringContaining(
					`minutes should be a whole number from 1 to ${MOST_GATE_MINUTES}`,
				),
			});
		}
		expect(
			gateFor({ merge: { gates: { [CORE]: { minutes: 30 } } } }, CORE),
			"a gate with a time and no command is refused",
		).toMatchObject({ kind: "malformed" });
	});

	it("says what's wrong with a gate it can't read, so the merge stops", () => {
		expect(
			gateFor({ merge: { gates: [] } }, CORE),
			"gates that aren't an object name both forms a gate takes",
		).toMatchObject({
			kind: "malformed",
			problem: expect.stringContaining('a command, or { "command"'),
		});
		expect(
			gateFor({ merge: { gates: { [CORE]: "" } } }, CORE),
			"an empty command is refused, naming the repo",
		).toMatchObject({
			kind: "malformed",
			problem: expect.stringContaining(CORE),
		});
	});

	it("lets a head through only when the gate, handed it, exits 0 in the checkout", async () => {
		const passing = `test "$(pwd -P)" = ${JSON.stringify(realpathSync(dir))} && test`;
		expect(
			await gateRefusal({ ...GATE, command: passing }, HEAD, dir, shell),
			"a gate exiting 0 in the checkout lets the head through",
		).toBeUndefined();
	});

	it("refuses with what the gate said", async () => {
		const refusing =
			"sh -c 'echo \"origin/main is not an ancestor of $0\" >&2; exit 3'";
		const said = await gateRefusal(
			{ ...GATE, command: refusing },
			HEAD,
			dir,
			shell,
		);
		expect(said, "the refusal gives the exit").toContain("exit 3");
		expect(said, "the refusal gives what the gate said").toContain(
			`origin/main is not an ancestor of ${HEAD}`,
		);
	});

	it("refuses when the gate isn't there to ask, or ran past its time", async () => {
		expect(
			await gateRefusal(
				{ ...GATE, command: "no-such-gate-here" },
				HEAD,
				dir,
				shell,
			),
			"a missing gate says so",
		).toMatch(/isn't on this machine/);
		const slow: RunGate = async () => ({
			code: 0,
			stdout: "",
			stderr: "",
			killed: true,
		});
		expect(
			await gateRefusal({ ...GATE, minutes: 30 }, HEAD, dir, slow),
			"a late gate says the time it had and how to name more",
		).toMatch(
			/still running after its 30 minutes[\s\S]*\{ "command": "merge-net ready", "minutes": 60 \}/,
		);
		expect(
			await gateRefusal({ ...GATE, minutes: 100 }, HEAD, dir, slow),
			"the more time offered stops at the most a gate may name",
		).toContain(`"minutes": ${MOST_GATE_MINUTES} }`);
		expect(
			await gateRefusal(
				{ ...GATE, minutes: 30, queued: true },
				HEAD,
				dir,
				slow,
			),
			"a late queued gate is offered more time, its base still queued",
		).toContain(`"minutes": 60, "base": "queued" }`);
		const broken: RunGate = async () => {
			throw new Error("spawn bash ENOENT");
		};
		expect(
			await gateRefusal(GATE, HEAD, dir, broken),
			"a gate that can't start says why",
		).toMatch(/couldn't run.*ENOENT/);
	});

	it("reads a gate's own exit 124 or 130 as its refusal, not as a clock or an Escape", async () => {
		// A gate wrapping a step in timeout(1) exits 124, and one whose child
		// took a SIGINT exits 130; neither ran out its minutes or was stopped.
		// Run under a call signal nothing aborts, as a real call is, so a
		// signal merely being there can't read as an Escape.
		for (const code of [124, 130]) {
			const said = await withCallSignal(new AbortController().signal, () =>
				gateRefusal(
					{ ...GATE, command: `echo inner step gave up >&2; exit ${code};` },
					HEAD,
					dir,
					shell,
				),
			);
			expect(said, `exit ${code} reads as the gate refusing`).toContain(
				`refused ${HEAD.slice(0, 12)} (exit ${code})`,
			);
			expect(said, `exit ${code} keeps what the gate said`).toContain(
				"inner step gave up",
			);
			expect(said, `exit ${code} gives no advice about minutes`).not.toMatch(
				/still running|stopped before/,
			);
		}
	});

	it("says a gate stopped by Escape was stopped, with everything it started", async () => {
		const marker = join(dir, "still-running");
		const pressed = new AbortController();
		setTimeout(() => pressed.abort(), 200); // long enough for bash to start the gate's child before Escape lands
		const said = await withCallSignal(pressed.signal, () =>
			gateRefusal(
				{
					...GATE,
					command: `(sleep 2; touch ${JSON.stringify(marker)}) & wait; true`,
				},
				HEAD,
				dir,
				shell,
			),
		);
		expect(said, "an Escape reads as the merge being stopped").toMatch(
			/The merge was stopped before its gate/,
		);
		await new Promise((done) => setTimeout(done, 2_500)); // past the child's own sleep, so a child left running would have touched the marker
		expect(
			existsSync(marker),
			"the call's signal reached the gate's whole group",
		).toBe(false);
	});

	it("says a gate at the most minutes it may name needs looking at, not more time", async () => {
		const slow: RunGate = async () => ({
			code: 130,
			stdout: "",
			stderr: "",
			killed: true,
		});
		const said = await gateRefusal(
			{ ...GATE, minutes: MOST_GATE_MINUTES },
			HEAD,
			dir,
			slow,
		);
		expect(said, "the ceiling is named").toContain(
			`${MOST_GATE_MINUTES} minutes is the most a gate may name`,
		);
		expect(said, "the time it already has is not offered again").not.toContain(
			'"minutes":',
		);
	});

	it("says a checkout that isn't there, rather than a gate refusing", async () => {
		const said = await gateRefusal(GATE, HEAD, join(dir, "gone"), shell);
		expect(said, "the missing folder is named").toContain(
			`couldn't run in ${join(dir, "gone")}: there is no such folder`,
		);
		expect(said, "the way out is named").toContain(
			"name a checkout of the repo with `repo`",
		);
		expect(said, "no gate is said to have refused").not.toContain("refused");
	});

	it("stops a gate past its time, with everything it started", async () => {
		// pi.exec killed only the shell, so a gate's children ran on after
		// a refusal said it had stopped.
		// Under a call signal nothing aborts, as a real call is, so its own
		// clock is told from an Escape with a signal there.
		const marker = join(dir, "still-running");
		const ran = await withCallSignal(new AbortController().signal, () =>
			shell(
				`echo 'gate: step 3' >&2; (sleep 5; touch ${JSON.stringify(marker)}) & wait`,
				dir,
				STARTS_MS, // short of the child's sleep
			),
		);
		expect(ran.killed, "a gate past its time is said to be stopped").toBe(true);
		expect(ran.aborted, "its own clock is no Escape").toBe(false);
		expect(
			ran.stderr,
			"the gate's own words, without the exec layer's note, which names neither gate nor clock",
		).toBe("gate: step 3");
		await new Promise((done) => setTimeout(done, 5_500 - STARTS_MS)); // past the child's own sleep, so a child left running would have touched the marker
		expect(
			existsSync(marker),
			"the gate's child went with it, rather than finishing after",
		).toBe(false);
	}, 15_000);

	// The clock fires, and the person presses Escape while the stopped gate
	// is still given its grace: the clock stopped it, so what is cut and
	// what the refusal says both follow the clock.
	it("follows the clock when Escape comes after it has stopped a gate", async () => {
		const termed = join(dir, "termed");
		const call = new AbortController();
		// The gate outlives its TERM, so it is still running when Escape
		// lands, and ends only at the grace's KILL. Its stderr is closed
		// after its line, so bash's own word on the killed sleep isn't said.
		const ran = withCallSignal(call.signal, () =>
			shell(
				`trap 'touch ${JSON.stringify(termed)}' TERM; echo 'bash aborted: This operation was aborted' >&2; exec 2>/dev/null; sleep 10; sleep 10`,
				dir,
				STARTS_MS,
			),
		);
		try {
			await until(termed, "the clock's TERM");
		} finally {
			call.abort(new Error("pressed"));
			await ran;
		}
		const stopped = await ran;
		expect(stopped.killed, "the clock stopped it").toBe(true);
		expect(stopped.aborted, "an Escape after the clock is no Escape").toBe(
			false,
		);
		expect(
			stopped.stderr,
			"the gate's own line, though it reads as the clock's note, and nothing after",
		).toBe("bash aborted: This operation was aborted");
	}, 20_000);

	it(
		"leaves nothing of the exec layer's when a call stops a gate that said nothing",
		async () => {
			const started = join(dir, "started");
			const call = new AbortController();
			const ran = withCallSignal(call.signal, () =>
				shell(`touch ${JSON.stringify(started)}; sleep 5`, dir, 10_000),
			);
			try {
				await until(started, "the gate's start");
			} finally {
				call.abort(new Error("pressed"));
				await ran;
			}
			const stopped = await ran;
			expect(stopped.aborted, "a stopped call is an Escape").toBe(true);
			expect(stopped.stderr, "nothing, as the gate said nothing").toBe("");
		},
		SPEAKS_MS + 5_000,
	);

	// A gate's own line reading as the exec layer's is the gate's to say.
	it.each([
		"stopped by\nthe person",
		"the bash aborted twice",
		"stopped\nbash aborted: again",
		// Ends in the before-start note's words, which spawnExec writes
		// only as the whole stderr of a run that never started.
		"stopped\nbash aborted before it started",
	])(
		"leaves out only the exec layer's note when a call is stopped for %j",
		async (reason) => {
			const spoke = join(dir, "spoke");
			const call = new AbortController();
			const ran = withCallSignal(call.signal, () =>
				shell(
					`echo 'bash aborted before it started' >&2; echo 'bash aborted: by the gate' >&2; touch ${JSON.stringify(spoke)}; sleep 5`,
					dir,
					10_000,
				),
			);
			try {
				await until(spoke, "the gate's speaking");
			} finally {
				// Stopped, and its end awaited, even when the wait fails, so no
				// gate runs on in a folder afterEach removes.
				call.abort(new Error(reason));
				await ran;
			}
			const stopped = await ran;
			expect(stopped.aborted, "a stopped call is an Escape").toBe(true);
			expect(stopped.stderr, "what the gate said, and nothing after").toBe(
				"bash aborted before it started\nbash aborted: by the gate",
			);
		},
		SPEAKS_MS + 5_000,
	);

	it("leaves out the exec layer's note for a call stopped before the gate starts", async () => {
		const call = new AbortController();
		call.abort();
		const ran = await withCallSignal(call.signal, () =>
			shell("echo never", dir, 10_000),
		);
		expect(ran.aborted, "a stopped call is an Escape").toBe(true);
		expect(ran.stderr, "nothing the gate said, as it never ran").toBe("");
	});
});

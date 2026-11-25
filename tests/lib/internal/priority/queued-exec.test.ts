import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EXIT_TIMED_OUT,
	type Exec,
	spawnExec,
} from "../../../../lib/core/exec/index.ts";
import { queueFolder } from "../../../../lib/internal/priority/folder.ts";
import {
	queuedExec,
	WORLD_PUSH_TURN,
} from "../../../../lib/internal/priority/queued-exec.ts";
import { queueHeavyWork } from "../../../../lib/internal/priority/turn.ts";
import "../../../../lib/internal/priority/unrooted-git.sh";
import { heldGit } from "../../../../lib/internal/sandbox/tree-git.ts";
import { at } from "../../../support/at.ts";

let root: string;
let dir: string;
let undo: (() => void) | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "queued-exec-"));
	dir = join(root, "jobs");
	mkdirSync(dir);
	writeFileSync(join(dir, "queue.json"), "{}\n");
});
afterEach(() => {
	undo?.();
	undo = undefined;
	rmSync(root, { recursive: true, force: true });
});

function keepQueue(): void {
	undo = queueHeavyWork({
		folder: queueFolder(dir, {
			isRunning: () => true,
			cgroupOf: () => undefined,
		}),
		session: "session-a",
		room: () => ({
			availableGib: 40,
			memoryPressure: 0,
			vms: 0,
			cpuPressure: 0,
			cores: 16,
			pressure: { cpu: 0, memory: 0, io: 0 },
		}),
		cgroupFor: () => undefined,
	});
}

/** An exec that answers at once and remembers what it was asked. */
function recording(): { exec: Exec; asked: [string, string[]][] } {
	const asked: [string, string[]][] = [];
	return {
		asked,
		exec: async (command, args) => {
			asked.push([command, args]);
			return { code: 0, stdout: "", stderr: "" };
		},
	};
}

const jobs = () =>
	readdirSync(dir)
		.filter((name) => name.endsWith(".job"))
		.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));

const world = join(homedir(), "world", "trees", "w-main", "src");

describe("a tool's git put through the machine's queue", () => {
	it("runs light work, and all work with no queue kept, as it was", async () => {
		const direct = recording();
		const queued = recording();
		const exec = queuedExec(direct.exec, queued.exec);

		await exec("git", ["-C", world, "push", "origin", "x"]);
		keepQueue();
		await exec("git", ["-C", world, "rev-parse", "--verify", "refs/heads/x"]);

		expect(direct.asked).toEqual([
			["git", ["-C", world, "push", "origin", "x"]],
			["git", ["-C", world, "rev-parse", "--verify", "refs/heads/x"]],
		]);
		expect(queued.asked).toEqual([]);
		expect(jobs()).toEqual([]);
	});

	it("runs a push of World as the queue's shell, waiting its turn as a walk", async () => {
		keepQueue();
		const direct = recording();
		const queued = recording();
		const exec = queuedExec(direct.exec, queued.exec);

		await exec("git", ["-C", world, "push", "--set-upstream", "origin", "x"]);

		expect(direct.asked).toEqual([]);
		const [command, args] = at(queued.asked, 0);
		expect(command).toBe("bash");
		expect(args[0]).toBe("-c");
		const shell = args[1] ?? "";
		const [job] = jobs();
		expect(job).toMatchObject({ kind: "world-walk", walk: "push" });
		expect(shell).toContain(`__job='${job.id}'`);
		expect(shell).toContain("core.hooksPath");
		expect(shell).toContain("--slice=");
		expect(shell).toContain(`git -C ${world} push --set-upstream origin x`);
	});

	it("answers with what git said once its turn comes", async () => {
		keepQueue();
		// The sandbox's runtime folder has no user bus, so the walk runs
		// outside the shared slice, as it does where there is no systemd.
		const exec = queuedExec(
			recording().exec,
			spawnExec({ timeoutMs: 60_000, env: { XDG_RUNTIME_DIR: "" } }),
		);
		const missing = join(homedir(), "world", "trees", "w-none-such", "src");

		const answer = exec("git", ["-C", missing, "push", "origin", "x"]);
		const [job] = jobs();
		writeFileSync(join(dir, `${job.id}.turn`), "");

		const result = await answer;
		expect(result.code).toBe(128);
		expect(result.stderr).toContain("w-none-such");
		expect(readFileSync(join(dir, `${job.id}.end`), "utf8").trim()).toBe("128");
	});

	it("hands the shell each word as it was given", async () => {
		keepQueue();
		const queued = recording();
		const exec = queuedExec(recording().exec, queued.exec);
		const odd = join(homedir(), "world", "trees", "it's", "src");

		await exec("git", ["-C", odd, "push", "origin", "x"]);

		const shell = queued.asked[0]?.[1][1] ?? "";
		const quoted = `'${odd.replace("'", `'\\''`)}'`;
		expect(shell).toContain(`git -C ${quoted} push origin x`);
	});
});

/** The script a queued git with no git above its folder runs behind. */
const UNROOTED = readFileSync(
	join(
		import.meta.dirname,
		"../../../../lib/internal/priority/unrooted-git.sh",
	),
	"utf8",
);

/** The work tool's own guard over git, with `home` as the home folder. */
const guardIn = (home: string) =>
	heldGit(() => ({ home, fenced: false, trees: join(home, "trees") }));

/** A git run as the queue's shell runs it, outside any user bus. */
const spawned = () =>
	spawnExec({ timeoutMs: 60_000, env: { XDG_RUNTIME_DIR: "" } });

/** What `UNROOTED` says and exits with, guarding `folder`, of `command`. */
function guarded(
	folder: string,
	command: string[],
): { code: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync(
			"bash",
			["-c", UNROOTED, "pi-unrooted-git", folder, ...command],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		return { code: 0, stdout, stderr: "" };
	} catch (error) {
		const failed = error as { status: number; stdout: string; stderr: string };
		return {
			code: failed.status,
			stdout: failed.stdout,
			stderr: failed.stderr,
		};
	}
}

// A command can put a `.git` in a folder that held none while a git pi
// runs there waits for its turn, naming a git folder whose hooks git
// would run outside the sandbox.
describe("a queued git in a folder with no git at or above it", () => {
	// The queue takes a push of World's trees, which it reads from home,
	// so home is here, holding a World tree with no git in it.
	let savedHome: string | undefined;
	let home: string;
	let trees: string;
	let folder: string;
	beforeEach(() => {
		savedHome = process.env.HOME;
		home = realpathSync(mkdtempSync(join(root, "home-")));
		process.env.HOME = home;
		trees = join(home, "world", "trees");
		folder = join(trees, "w-plain", "src");
		mkdirSync(folder, { recursive: true });
	});
	afterEach(() => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
	});

	/** A push of `path` through the guard, and the job the queue holds it as. */
	function queuedPush(path: string) {
		keepQueue();
		const exec = queuedExec(recording().exec, spawned(), guardIn(home));
		const answer = exec("git", ["-C", path, "push", "origin", "x"]);
		const [job] = jobs();
		return {
			answer,
			turn: () => writeFileSync(join(dir, `${job.id}.turn`), ""),
		};
	}

	it("runs at once as it was when the queue doesn't take it", async () => {
		const direct = recording();
		const exec = queuedExec(direct.exec, recording().exec, guardIn(home));

		await exec("git", ["-C", folder, "status"]);

		expect(direct.asked).toEqual([
			["git", ["-c", "core.fsmonitor=false", "-C", folder, "status"]],
		]);
	});

	it("won't run once a .git was put in its folder while it waited", async () => {
		const push = queuedPush(folder);
		writeFileSync(join(folder, ".git"), "gitdir: /elsewhere\n");
		push.turn();

		const result = await push.answer;
		expect(result.code, result.stderr).toBe(126);
		expect(result.stderr).toContain("holds a git now");
		expect(result.stderr).toContain("Nothing ran.");
	});

	it("runs once its turn comes while its folder still holds none", async () => {
		const push = queuedPush(folder);
		push.turn();

		const result = await push.answer;
		expect(result.code, result.stderr).toBe(128);
		expect(result.stderr).toContain("fatal: not a git repository");
	});

	// git once went back through the path it was given, so a link in it
	// repointed while it waited led it to a repository of a command's own.
	it("runs in the folder it looked at, though a link in its path was repointed", async () => {
		const evil = join(home, "evil");
		mkdirSync(join(evil, "src"), { recursive: true });
		execFileSync("git", ["init", "-q", join(evil, "src")]);
		const link = join(trees, "w-link");
		symlinkSync(join(trees, "w-plain"), link);
		const push = queuedPush(join(link, "src"));
		rmSync(link);
		symlinkSync(evil, link);
		push.turn();

		const result = await push.answer;
		expect(result.code, result.stderr).toBe(128);
		expect(result.stderr).toContain("fatal: not a git repository");
	});

	it("won't run once its folder was swapped for a link while it waited", async () => {
		const evil = join(home, "evil");
		mkdirSync(evil);
		const push = queuedPush(folder);
		renameSync(folder, join(trees, "w-plain", "aside"));
		symlinkSync(evil, folder);
		push.turn();

		const result = await push.answer;
		expect(result.code, result.stderr).toBe(126);
		expect(result.stderr).toContain("isn't where it was");
	});

	it.each([
		["a .git file", [".git"], []],
		["a .git link", [], [".git"]],
		["a bare repository", ["HEAD"], ["objects"]],
		["a bare repository of links", [], ["HEAD", "objects"]],
	])("won't run where %s stands above its folder", (_, files, links) => {
		const above = realpathSync(mkdtempSync(join(root, "above-")));
		const folder = join(above, "below");
		mkdirSync(folder);
		for (const file of files) writeFileSync(join(above, file), "");
		for (const link of links) symlinkSync(root, join(above, link));

		const said = guarded(folder, ["true"]);

		expect(said.code, said.stderr).toBe(126);
		expect(said.stderr).toContain(`${above} holds a git now`);
	});

	it.each([
		[
			"a .git link to nothing yet",
			(above: string) => symlinkSync(join(above, "none"), join(above, ".git")),
		],
		[
			"a bare repository whose objects come from elsewhere",
			(above: string) => {
				writeFileSync(join(above, "HEAD"), "ref: refs/heads/x\n");
				writeFileSync(join(above, "commondir"), "/elsewhere\n");
			},
		],
	])("won't run where %s stands above its folder", (_, plant) => {
		const above = realpathSync(mkdtempSync(join(root, "above-")));
		const below = join(above, "below");
		mkdirSync(below);
		plant(above);

		const said = guarded(below, ["true"]);

		expect(said.code, said.stderr).toBe(126);
		expect(said.stderr).toContain(`${above} holds a git now`);
	});

	it("runs where a folder above holds only half of a bare repository", () => {
		const above = realpathSync(mkdtempSync(join(root, "above-")));
		const below = join(above, "below");
		mkdirSync(below);
		writeFileSync(join(above, "HEAD"), "");
		writeFileSync(join(above, "objects"), "");

		expect(guarded(below, ["true"])).toEqual({
			code: 0,
			stdout: "",
			stderr: "",
		});
	});

	it("won't run below a folder whose name holds a colon, which git splits its ceiling at", () => {
		const above = join(realpathSync(mkdtempSync(join(root, "above-"))), "a:b");
		const below = join(above, "below");
		mkdirSync(below, { recursive: true });

		const said = guarded(below, ["true"]);

		expect(said.code, said.stderr).toBe(126);
		expect(said.stderr).toContain("holds a colon");
	});

	it("keeps git from finding a repository put above its folder after the look", () => {
		const above = realpathSync(mkdtempSync(join(root, "above-")));
		const below = join(above, "below");
		mkdirSync(below);

		const said = guarded(below, [
			"sh",
			"-c",
			"git init -q .. && git rev-parse --git-dir",
		]);

		expect(said.code, said.stderr).toBe(128);
		expect(said.stderr).toContain("not a git repository");
	});
});

/**
 * World's push gate's lines, word for word as its program
 * (world-push-gate 0.1.0) says them; a gate that changes its words
 * changes these.
 */
const GATE = {
	waits:
		"world-push-gate: another push to World is running; this one waits its turn.",
	came: "world-push-gate: its turn came after 1 s",
	gaveUp:
		"world-push-gate: waited 30 minutes for another push; this one goes on",
	couldNot: "world-push-gate: couldn't take a turn; this push goes on",
} as const;

/**
 * A push on a clock of 600 ms that says `waits` on stderr, a second on
 * `goes`, then `back` on stdout, and a second on sends. Held through the
 * wait and run again after it, its clock ends it once `back` is said and
 * before `sent`; held too long, the signal ends it at four seconds.
 */
function gatedPush(waits: string, goes: string) {
	return spawnExec({
		timeoutMs: 600,
		signal: AbortSignal.timeout(4_000),
		turn: WORLD_PUSH_TURN,
	})("sh", [
		"-c",
		`echo "${waits}" >&2; sleep 1; echo "${goes}" >&2; echo back; sleep 1; echo sent`,
	]);
}

describe("World's push gate's turn", () => {
	it.each([
		["its turn came", GATE.came],
		["it gave up waiting", GATE.gaveUp],
		["it couldn't take a turn", GATE.couldNot],
	])("holds a push's clock from the gate's wait until %s", async (_, goes) => {
		const result = await gatedPush(GATE.waits, goes);
		expect(result.stdout, "the gate's wait is not run time").toContain("back");
		expect(result.code, "the clock runs again after the wait").toBe(
			EXIT_TIMED_OUT,
		);
		expect(result.stderr).toContain("timed out after 600 ms");
		expect(result.stdout).not.toContain("sent");
	});

	it.each([
		["without the gate's name", "remote: "],
		["another program passed on", "remote: world-push-gate: "],
	])("holds nothing for the gate's words %s", async (_, prefix) => {
		const result = await gatedPush(
			GATE.waits.replace("world-push-gate: ", prefix),
			GATE.came,
		);
		expect(result.stdout, "only the gate stops the clock").not.toContain(
			"back",
		);
		expect(result.code).toBe(EXIT_TIMED_OUT);
	});
});

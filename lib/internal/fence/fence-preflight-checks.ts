/**
 * The pre-flight's checks (`fence-preflight.ts`), numbered as in ISXEG8's
 * list of 14 November: the person's paths (1 to 4), agents' (5 to 12),
 * and what stays refused (13 to 15), plus the builders' and the GitHub
 * door's own and git outside a tree while a plant is tried inside.
 *
 * The checks of the person's desktop, the clipboard and windows, are
 * in `fence-preflight-desktop.ts`.
 */

import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { SANDBOX_VARIABLE, sandboxFor } from "../sandbox/sandbox.ts";
import { askRoute, asksAnswered } from "../secrets/secret-ask.ts";
import { FENCE, LET_THROUGH, NEVER_THROUGH } from "./fence.ts";
import { lenderFolders } from "./fence-builders.ts";
import { DISK } from "./fence-disk.ts";
import { GCLOUD_KEY, KEY_STAND_IN } from "./fence-gcloud-ssh.ts";
import { FENCE_HIDDEN } from "./fence-hidden.ts";
import {
	type Check,
	failed,
	fenced,
	fresh,
	inSession,
	outside,
	type PreflightContext,
	passed,
	type Ran,
	refusedAs,
	succeeded,
	tailOf,
	type Verdict,
} from "./fence-preflight.ts";
import {
	clipboardRoundTrip,
	focusedWindow,
	windowBehind,
	xDisplayOut,
} from "./fence-preflight-desktop.ts";
import { everydayGit, heldTreeGit, plantLoop } from "./fence-preflight-git.ts";

/** How long a build sent to the builders may take. */
const BUILD_LIMIT_MS = 1_900_000;

/** How long fetching a tool from the cache and running it may take. */
const FETCH_LIMIT_MS = 600_000;

/** The runtime folder, where the person's sockets are. */
function runtime(): string {
	return process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;
}

/** Check (3): the change installing touches no niri, shell or launcher code. */
async function launcherUntouched(context: PreflightContext): Promise<Verdict> {
	const ran = await outside(
		"git diff --name-only origin/main...HEAD",
		context.repo,
	);
	if (ran.code !== 0) return failed(`git diff failed: ${tailOf(ran)}`);
	const touched = ran.out
		.split("\n")
		.filter((path) => /quickshell|niri|launcher/i.test(path));
	return touched.length === 0
		? passed("the change touches no niri, shell or launcher file")
		: failed(
				`it touches ${touched.join(", ")}: run the launcher's VM subtests first`,
			);
}

/** A check needing a held core tree, or a failure saying one is needed. */
function inCoreTree(
	run: (tree: string, context: PreflightContext) => Promise<Verdict>,
): (context: PreflightContext) => Promise<Verdict> {
	return async (context) =>
		context.coreTree
			? run(context.coreTree, context)
			: failed("needs --core-tree, a held core.nix tree");
}

/** A check that sends work to the builders, run only when asked. */
function heavy(
	run: (context: PreflightContext) => Promise<Verdict>,
): (context: PreflightContext) => Promise<Verdict> {
	return async (context) =>
		context.heavy
			? run(context)
			: failed("sends builds to the builders: run with --heavy");
}

/** Check (10b): a lock one fenced command holds is seen by another. */
async function lockAcrossCommands(context: PreflightContext): Promise<Verdict> {
	const armed = join(homedir(), ".cache", "builder-armed");
	mkdirSync(armed, { recursive: true });
	const live = join(armed, `${fresh()}.live`);
	try {
		const holding = fenced(
			`flock ${live} -c 'sleep 8'`,
			context.scratch,
			context.session,
		);
		// The holder needs a moment to take the lock before it's tried.
		await new Promise((resolve) => setTimeout(resolve, 2000));
		const tried = await fenced(
			`flock -n ${live} true`,
			context.scratch,
			context.session,
		);
		const held = await holding;
		if (held.code !== 0) return failed(`the holder failed: ${tailOf(held)}`);
		return tried.code === 1
			? passed("the second fenced command saw the first's lock")
			: failed(`the second command took the lock (exit ${tried.code})`);
	} finally {
		rmSync(live, { force: true });
	}
}

/** Check (13): each file the fence hides, that exists, can't be read inside. */
async function hiddenUnread(context: PreflightContext): Promise<Verdict> {
	const home = homedir();
	const sshKeys = existsSync(join(home, ".ssh"))
		? readdirSync(join(home, ".ssh"))
				.filter((name) => name.startsWith("id_") && !name.endsWith(".pub"))
				.map((name) => join(home, ".ssh", name))
		: [];
	const paths = [
		...FENCE_HIDDEN.home
			.filter((path) => !path.endsWith("/"))
			.map((path) => join(home, path)),
		...sshKeys,
		join(home, ".local/share/keyrings/login.keyring"),
		...lenderFolders(DISK).map((folder) => join(folder, "cloud-token")),
	].filter((path) => existsSync(path));
	const read: string[] = [];
	for (const path of paths) {
		// On Linux a hidden file reads as `/dev/null`, which opens and is
		// empty, so a read counts only when it brings something back.
		const ran = await fenced(
			`head -c1 '${path}' > /dev/null 2>&1 && test -s '${path}'`,
			context.scratch,
			context.session,
		);
		if (ran.code === 0) read.push(path);
	}
	// gcloud's private key is bound over by a stand-in on purpose
	// (fence-gcloud-ssh.ts), so inside it must read as that and nothing else,
	// or not at all. Only its digest comes out, so a fence that let the real
	// key through still never brings the key itself into pi. The probe says
	// `unread` itself where the key can't be read, read as the files above
	// are, so a run that fails (a refused wrap, a timeout, a missing
	// sha256sum) proves nothing and fails the check.
	const gcloudKey = join(home, ".ssh", GCLOUD_KEY);
	const checked = existsSync(gcloudKey) ? 1 : 0;
	if (checked) {
		const ran = await fenced(
			`if head -c1 '${gcloudKey}' > /dev/null 2>&1 && test -s '${gcloudKey}'; then sha256sum < '${gcloudKey}'; else echo unread; fi`,
			context.scratch,
			context.session,
		);
		if (!readsAsStandIn(ran)) read.push(gcloudKey);
	}
	return read.length === 0
		? passed(`${paths.length + checked} hidden files, none readable inside`)
		: failed(`readable inside: ${read.join(", ")}`);
}

/**
 * Whether a fenced digest of gcloud's key says the key read as the
 * stand-in, or couldn't be read: the probe's own `unread`, or the digest
 * `sha256sum` ends its output with, whatever the wrap printed before it,
 * against the stand-in's own. A probe that didn't end 0 said neither.
 */
export function readsAsStandIn(ran: {
	code: number | null;
	out: string;
}): boolean {
	if (ran.code !== 0) return false;
	const said = ran.out.trim().split(/\s+/);
	if (said.at(-1) === "unread") return true;
	const digest = createHash("sha256").update(KEY_STAND_IN).digest("hex");
	return said.at(-2) === digest;
}

/**
 * What a fenced node says of its connect to the socket at its argument:
 * `connected`, or the error's code, EACCES being Landlock's refusal.
 */
const CONNECT = [
	'const s = require("node:net").connect(process.argv[1]);',
	'const say = (what) => process.stdout.write(what + "\\n", () => process.exit(0));',
	's.on("connect", () => say("connected"));',
	's.on("error", (e) => say(e.code));',
].join(" ");

/**
 * The paths a never-through name stands for here: itself, or each entry
 * of the runtime folder a name ending in a wildcard matches. An entry
 * whose name holds a quote or a line break is left out, since it would
 * break the probe's script or forge a line of its answer, so its name
 * reads as not tried (`leavesOut`).
 */
function servedAs(name: string, entries: readonly string[]): string[] {
	if (isAbsolute(name)) return [name];
	if (!name.endsWith("*")) return [join(runtime(), name)];
	const start = name.slice(0, -1);
	return entries
		.filter((entry) => entry.startsWith(start) && !/['\n]/.test(entry))
		.map((entry) => join(runtime(), entry));
}

/**
 * Whether `servedAs` leaves out any entry `name` matches, so the name
 * can't be said to be tried, however many of its other matches were.
 */
function leavesOut(name: string, entries: readonly string[]): boolean {
	const start = name.slice(0, -1);
	return (
		name.endsWith("*") &&
		entries.some((entry) => entry.startsWith(start) && /['\n]/.test(entry))
	);
}

/** A line saying how a connect to `path` went, run outside or inside. */
function connectTo(path: string): string {
	return `printf 'connect %s ' '${path}'; '${process.execPath}' -e '${CONNECT}' '${path}'`;
}

/**
 * Check (13b): no socket the fence never lets through is reached inside.
 * One in the runtime folder must be absent, since that folder starts
 * inside as an empty tmpfs; an absolute one is seen through the whole
 * disk's bind, so it is connected to, and Landlock must refuse it or
 * the fence hide it. An absolute one is tried only once it connects
 * outside, so a refusal inside is the fence's, not one the person meets
 * anyway. Each is tried in one fenced run that first sees a socket the
 * fence lets through, and each probe says what it found, so a fence that
 * never ran fails rather than reading as every socket kept shut. A name
 * not served here can't be tried, so each is named rather than passed
 * over, and a machine serving none fails, having shown nothing.
 */
async function socketsAbsent(context: PreflightContext): Promise<Verdict> {
	const entries = existsSync(runtime()) ? readdirSync(runtime()) : [];
	const control = LET_THROUGH.map((name) => join(runtime(), name)).find(
		(path) => existsSync(path),
	);
	if (control === undefined) {
		return failed(
			"nothing the fence lets through is served here to show it ran",
		);
	}
	const connected = (path: string) => !path.startsWith(`${runtime()}/`);
	const there = NEVER_THROUGH.flatMap((name) => servedAs(name, entries)).filter(
		(path) => existsSync(path),
	);
	const absolute = there.filter(connected);
	const tried =
		absolute.length === 0
			? undefined
			: await outside(absolute.map(connectTo).join("\n"), context.scratch);
	const before = tried?.out.split("\n") ?? [];
	const served = there.filter(
		(path) => !connected(path) || before.includes(`connect ${path} connected`),
	);
	if (served.length === 0) {
		return failed(
			"no socket the fence never lets through answers here, so none was tried",
		);
	}
	const untried = NEVER_THROUGH.filter(
		(name) =>
			leavesOut(name, entries) ||
			servedAs(name, entries).every((path) => !served.includes(path)),
	);
	const probe = (path: string) =>
		connected(path)
			? connectTo(path)
			: `if test -e '${path}'; then echo 'there ${path}'; else echo 'absent ${path}'; fi`;
	const ran = await fenced(
		[
			`test -e '${control}' && echo control`,
			...served.map((path) => probe(path)),
			"echo probed",
		].join("\n"),
		context.scratch,
		context.session,
	);
	const lines = ran.out.split("\n").filter((line) => line !== "");
	if (lines.at(-1) !== "probed") {
		return failed(
			`the fenced probe didn't run through (exit ${ran.code}), so not every socket was tried`,
		);
	}
	if (lines[0] !== "control") {
		return failed(
			`${control}, which the fence lets through, wasn't seen inside, so nothing shows the probe ran fenced`,
		);
	}
	// Kept shut: absent from the runtime folder, or, connected to,
	// refused by Landlock or hidden by the fence. Anything else, a probe
	// that said nothing among it, is reached or untold.
	const reached = served.filter((path) =>
		connected(path)
			? !["EACCES", "ENOENT"].some((code) =>
					lines.includes(`connect ${path} ${code}`),
				)
			: !lines.includes(`absent ${path}`),
	);
	return reached.length === 0
		? passed(
				`${served.length} sockets, none reached inside; not tried here: ${untried.join(", ") || "none"}`,
			)
		: failed(`reached or not told inside: ${reached.join(", ")}`);
}

/** Check (14c): another session's tree can't be written. */
async function otherTreeUnwritable(
	context: PreflightContext,
): Promise<Verdict> {
	const trees = join(
		homedir(),
		".local/state/pi/agentic-harness.pi/work/trees",
	);
	// A tree the broker cut, not a scratch folder beside them.
	const other = readdirSync(trees)
		.filter((name) => name.startsWith("worktree-"))
		.map((name) => join(trees, name))
		.find((tree) => !context.repo.startsWith(tree));
	if (!other) return failed("no other tree to try");
	const probe = join(other, `${fresh()}`);
	const ran = await fenced(`touch '${probe}'`, context.repo, context.session);
	rmSync(probe, { force: true });
	return refusedAs(ran, `writing in ${other}`);
}

/**
 * A download run outside the fence and then inside, each into a fresh
 * folder made by `prepare`; it passes when both succeed, and says both
 * times, since every fenced byte passes the relay.
 */
async function timedBesideUnfenced(
	what: string,
	scratch: string,
	prepare: (target: string) => { script: string; cwd: string },
	session: string,
): Promise<Verdict> {
	const runOnce = async (inside: boolean) => {
		const target = join(scratch, fresh());
		const { script, cwd } = prepare(target);
		try {
			return inside
				? await fenced(script, cwd, session, FETCH_LIMIT_MS)
				: await outside(script, cwd, FETCH_LIMIT_MS);
		} finally {
			rmSync(target, { recursive: true, force: true });
		}
	};
	const plain = await runOnce(false);
	const inside = await runOnce(true);
	if (plain.code !== 0)
		return failed(`${what} failed outside: ${tailOf(plain)}`);
	if (inside.code !== 0)
		return failed(`${what} failed inside: ${tailOf(inside)}`);
	return passed(`${what}: ${inside.ms} ms fenced, ${plain.ms} ms outside`);
}

/** Every check, in the order the pre-flight runs them. */
export const CHECKS: readonly Check[] = [
	{
		id: "1",
		group: "person",
		what: "copy and paste from a fenced command",
		run: clipboardRoundTrip,
	},
	{
		id: "1b",
		group: "person",
		what: "a fenced window opens behind, the focus unmoved",
		run: windowBehind,
	},
	{
		id: "2",
		group: "person",
		what: "niri answers the focused window",
		run: async ({ scratch }) =>
			(await focusedWindow(scratch)) === undefined
				? failed("niri msg -j focused-window gave no window")
				: passed("niri named the focused window"),
	},
	{
		id: "3",
		group: "person",
		what: "the change leaves the launcher alone",
		run: launcherUntouched,
	},
	{
		id: "4a",
		group: "person",
		what: "gh signs in through the door",
		// The active account alone: the keyring's, which the fence hides on
		// purpose, would read as invalid beside the door's token.
		run: async ({ scratch, session }) =>
			succeeded(
				await fenced("gh auth status --active", scratch, session),
				"gh auth status --active",
			),
	},
	{
		id: "4b",
		group: "person",
		what: "the Google and Slack readers stand",
		run: async ({ scratch }) =>
			succeeded(
				await outside(
					"jobs-broker status google.socket slack-unreads.socket",
					scratch,
				),
				"jobs-broker status of both",
			),
	},
	{
		id: "5a",
		group: "agents",
		what: "git fetch in a held core tree",
		run: inCoreTree(async (tree, { session }) =>
			succeeded(
				await fenced("git fetch origin", tree, session),
				"git fetch origin",
			),
		),
	},
	{
		id: "5b",
		group: "agents",
		what: "merge-net reads where a change stands",
		run: inCoreTree(async (tree, { session }) =>
			succeeded(
				await fenced("merge-net status && merge-net needs", tree, session),
				"merge-net status and needs",
			),
		),
	},
	{
		id: "5c",
		group: "agents",
		what: "merge-net ready on main's head answers inside as it does outside",
		run: heavy(
			inCoreTree(async (tree, { session }) => {
				// Whether main's head has a recorded pass is merge-net's to say,
				// not the fence's: the fence only must not change the answer.
				const ready = "merge-net ready $(git rev-parse origin/main)";
				const plain = await outside(ready, tree, BUILD_LIMIT_MS);
				const inside = await fenced(ready, tree, session, BUILD_LIMIT_MS);
				const answer = (ran: Ran) => tailOf(ran, 1);
				return plain.code === inside.code && answer(plain) === answer(inside)
					? passed(
							`merge-net ready exited ${inside.code} on both sides (${inside.ms} ms fenced): ${answer(inside)}`,
						)
					: failed(
							`merge-net ready differs: outside exited ${plain.code} saying ${answer(plain)}; inside exited ${inside.code} saying ${answer(inside)}`,
						);
			}),
		),
	},
	{
		id: "5e",
		group: "agents",
		what: "commit, branch, fetch, rebase, status and push in a fenced worktree whose shared git folder is read-only, and a branch delete told the route",
		run: everydayGit,
	},
	{
		id: "5f",
		group: "agents",
		what: "a commit and a fetch in a worktree the session holds, from a command started elsewhere, and one it doesn't hold still refused",
		run: heldTreeGit,
	},
	{
		id: "5d",
		group: "agents",
		what: "a World tree cut writable and registered; work record and push on a scratch branch",
		run: async () =>
			inSession(
				"a fenced session cuts a World tree with the work tool, writes in it, and records and pushes a scratch branch, then releases it",
			),
	},
	{
		id: "6a",
		group: "agents",
		what: "nix-offload there --changed reaches a builder",
		run: heavy(
			inCoreTree(async (tree, { session }) => {
				const ran = await fenced(
					"nix-offload there --changed",
					tree,
					session,
					BUILD_LIMIT_MS,
				);
				// A head whose checks passed before is remembered, and nothing
				// reaches a builder: that proves nothing about the fence.
				if (/passed at \S+ already/.test(ran.err + ran.out)) {
					return failed(
						"the tree's head passed before, so nothing went to a builder; run `nix-offload passed forget <head>` outside first",
					);
				}
				return succeeded(ran, "nix-offload there --changed");
			}),
		),
	},
	{
		id: "6b",
		group: "agents",
		what: "a lone there <drv>^* reaches a builder",
		run: heavy(async ({ scratch, session }) =>
			succeeded(
				await fenced(
					'nix-offload there "$(nix eval --raw nixpkgs#hello.drvPath)^*"',
					scratch,
					session,
					BUILD_LIMIT_MS,
				),
				"there <drv>^*",
			),
		),
	},
	{
		id: "7a",
		group: "agents",
		what: "gh api user",
		run: async ({ scratch, session }) =>
			succeeded(
				await fenced("gh api user -q .login", scratch, session),
				"gh api user",
			),
	},
	{
		id: "7b",
		group: "agents",
		what: "a GraphQL query, a project read and a sub-issue read",
		run: async ({ scratch, session }) =>
			succeeded(
				await fenced(
					[
						"gh api graphql -f query='{viewer{login}}'",
						"gh api graphql -f query='{viewer{projectsV2(first:5){nodes{id}}}}'",
						`gh api graphql -f query='{repository(owner:"cli",name:"cli"){issues(first:1){nodes{number subIssues(first:1){totalCount}}}}}'`,
					].join(" && "),
					scratch,
					session,
				),
				"three GraphQL reads",
			),
	},
	{
		id: "8",
		group: "agents",
		what: "the GPU's render node opens a context, with no flag",
		run: async ({ scratch, session }) => {
			const ran = await fenced(
				"nix shell nixpkgs#mesa-demos -c eglinfo -B -p surfaceless",
				scratch,
				session,
				FETCH_LIMIT_MS,
			);
			const renderer = /OpenGL core profile renderer: (.*)/.exec(ran.out)?.[1];
			if (ran.code !== 0 || !renderer) {
				return failed(`eglinfo found no GPU: ${tailOf(ran)}`);
			}
			return /llvmpipe|softpipe/i.test(renderer)
				? failed(`only software drawing: ${renderer}`)
				: passed(`drew through ${renderer}`);
		},
	},
	{
		id: "9a",
		group: "agents",
		what: "secret_run finds its daemon, which no command reaches",
		// secret_run asks from pi, outside the fence, and only the fence
		// keeps a command from the asks and from the secret-asks daemon's
		// socket, which takes a yes from anything that reaches it (core's
		// secret-asks daemon.rs). So the daemon is found from outside, by
		// its socket or the passwords daemon's sign, and neither the socket
		// nor the asks from inside, and no ask is ever filed, since one
		// pings Joel.
		run: async ({ scratch, session }) => {
			const socket = join(runtime(), "daemons", "secret-asks.sock");
			const asks = join(runtime(), "secret-asks");
			if (!asksAnswered(runtime())) {
				return failed(
					`nothing answers the asks in ${asks}: no secret-asks socket at ${socket}, and no answering sign there naming a running passwords daemon`,
				);
			}
			const by = existsSync(socket)
				? "the secret-asks daemon's socket"
				: "the passwords daemon's answering sign";
			if (!existsSync(asks)) return failed(`no asks folder at ${asks}`);
			const inside = await fenced(
				`test -e '${socket}' || test -e '${asks}'`,
				scratch,
				session,
			);
			return inside.code === 0
				? failed("a fenced command reaches the daemon or its asks")
				: passed(`${by} and the asks are there for pi, and not inside`);
		},
	},
	{
		id: "9d",
		group: "agents",
		what: "a fenced command naming secret-asks is told of secret_run",
		// Named, never run: an ask that reached the daemon would ping Joel.
		run: async ({ scratch, session }) => {
			const ran = await fenced(": secret-asks", scratch, session);
			return ran.err.includes("secret_run")
				? passed("told to ask with secret_run")
				: failed(`no word of secret_run: ${tailOf(ran)}`);
		},
	},
	{
		id: "9e",
		group: "agents",
		what: "secret_run, outside, could file an ask",
		// secret_run's own checks for a fenced session, up to the filing,
		// which is left out so nothing shows in the launcher.
		run: async () => {
			const env = { ...process.env, [SANDBOX_VARIABLE]: FENCE };
			const route = askRoute({
				fenced: sandboxFor(env).kind === "fence",
				runtimeDir: runtime(),
			});
			if ("refused" in route) return failed(route.refused);
			try {
				accessSync(route.folder, constants.W_OK);
			} catch (error) {
				return failed(`pi can't write ${route.folder}: ${String(error)}`);
			}
			return passed(`it would file in ${route.folder}`);
		},
	},
	{
		id: "9b",
		group: "agents",
		what: "an untrusted Nix build",
		run: async ({ scratch, session }) => {
			const word = fresh();
			return succeeded(
				await fenced(
					`nix build --no-link --impure --expr 'with builtins.getFlake "nixpkgs"; legacyPackages.\${builtins.currentSystem}.runCommand "${word}" {} "echo ${word} > $out"'`,
					scratch,
					session,
					FETCH_LIMIT_MS,
				),
				"nix build of a new derivation",
			);
		},
	},
	{
		id: "9c",
		group: "agents",
		what: "jobs-broker status answers",
		run: async ({ scratch, session }) =>
			succeeded(
				await fenced(
					"jobs-broker status pi-agent-proxy.socket",
					scratch,
					session,
				),
				"jobs-broker status",
			),
	},
	{
		id: "10a",
		group: "agents",
		what: "MDAZQV's turn-taking test",
		run: async ({ scratch, session }) => {
			const tests = join(
				homedir(),
				".cache/builder-offload-tests/claimtest/fence.sh",
			);
			const script = join(homedir(), ".cache/builder-offload.sh");
			if (!existsSync(tests) || !existsSync(script)) {
				return failed("fence.sh or builder-offload.sh isn't in ~/.cache");
			}
			const ran = await fenced(`bash '${tests}' '${script}'`, scratch, session);
			return ran.code === 0 && !/^FAIL/m.test(ran.out)
				? passed(`${(ran.out.match(/^PASS/gm) ?? []).length} passed`)
				: failed(tailOf(ran, 6));
		},
	},
	{
		id: "10b",
		group: "agents",
		what: "a lock held across two fenced commands",
		run: lockAcrossCommands,
	},
	{
		id: "11",
		group: "agents",
		what: "every refusal's named route works",
		run: async () =>
			inSession(
				"a fenced session meets each refusal (a hidden path from pi's file tools, a write outside its tree, the door's push, propose and merge) and takes the route each names",
			),
	},
	{
		id: "12",
		group: "agents",
		what: "install then revert on a canary",
		run: async () =>
			inSession(
				"install on a canary session, revert, and see PI_SANDBOX unset and wl-copy working in it within 10 minutes, with no restart",
			),
	},
	{
		id: "13a",
		group: "refused",
		what: "keys, the keyring and the builders' key and token stay hidden",
		run: hiddenUnread,
	},
	{
		id: "13b",
		group: "refused",
		what: "sockets never let through stay out",
		run: socketsAbsent,
	},
	{
		id: "14a",
		group: "refused",
		what: "a main checkout's hooks stay read-only",
		run: async ({ session }) => {
			const checkout = join(homedir(), "src", "agentic-harness.pi");
			const probe = join(checkout, ".git", "hooks", fresh());
			const ran = await fenced(`touch '${probe}'`, checkout, session);
			rmSync(probe, { force: true });
			return refusedAs(ran, "writing .git/hooks");
		},
	},
	{
		id: "14b",
		group: "refused",
		what: "a main checkout's settings stay read-only",
		run: async ({ session }) => {
			const checkout = join(homedir(), "src", "agentic-harness.pi");
			const key = `${fresh().replace("-", "")}.x`;
			const ran = await fenced(
				`git config --local ${key} 1`,
				checkout,
				session,
			);
			await outside(`git config --local --unset ${key}`, checkout);
			return refusedAs(ran, "git config --local");
		},
	},
	{
		id: "14c",
		group: "refused",
		what: "another session's tree stays read-only",
		run: otherTreeUnwritable,
	},
	{
		id: "15a",
		group: "refused",
		what: "the GPU's display nodes stay out",
		run: async ({ scratch, session }) =>
			refusedAs(
				await fenced("ls /dev/dri/card* 2>&1", scratch, session),
				"listing /dev/dri/card*",
			),
	},
	{
		id: "15b",
		group: "refused",
		what: "gh calls for keys, tokens, secrets and hooks are refused",
		run: async ({ scratch, session }) => {
			const calls = [
				"user/keys",
				"repos/Jitsusama/private-clone-test/hooks",
				"repos/Jitsusama/private-clone-test/actions/secrets",
			];
			const through: string[] = [];
			for (const call of calls) {
				const ran = await fenced(`gh api ${call}`, scratch, session);
				if (ran.code === 0) through.push(call);
			}
			return through.length === 0
				? passed(`${calls.length} calls refused`)
				: failed(`let through: ${through.join(", ")}`);
		},
	},
	{
		id: "15c",
		group: "refused",
		what: "the compositor's own socket and niri's stay out",
		run: async ({ scratch, session }) =>
			refusedAs(
				await fenced(
					'test "$WAYLAND_DISPLAY" = wayland-1 || test -n "$NIRI_SOCKET" || test -S "$XDG_RUNTIME_DIR/wayland-1" || ls "$XDG_RUNTIME_DIR"/niri.* > /dev/null 2>&1',
					scratch,
					session,
				),
				"finding wayland-1 or niri's socket",
			),
	},
	{
		id: "15d",
		group: "refused",
		what: "X's sockets stay out, file and abstract",
		run: xDisplayOut,
	},
	{
		id: "j",
		group: "refused",
		what: "git outside sees no redirect while a plant is tried inside",
		run: plantLoop,
	},
	{
		id: "b1",
		group: "person",
		what: "the person's own SSH agent still answers",
		run: async ({ scratch }) =>
			succeeded(await outside("ssh-add -l", scratch), "ssh-add -l outside"),
	},
	{
		id: "d1",
		group: "agents",
		what: "a large download from elsewhere, through the relay",
		run: heavy(({ scratch, session }) =>
			timedBesideUnfenced(
				// curl rather than npm, whose wrapper on a work machine needs its
				// own settings outside before it runs at all.
				"a download of typescript's package from npm's registry",
				scratch,
				(target) => {
					mkdirSync(target, { recursive: true });
					return {
						script:
							"curl -sSfL --max-time 120 -o typescript.tgz https://registry.npmjs.org/typescript/-/typescript-5.6.3.tgz && test $(stat -c %s typescript.tgz) -gt 1000000",
						cwd: target,
					};
				},
				session,
			),
		),
	},
	{
		id: "d2",
		group: "agents",
		what: "a large GitHub clone over https, through the door",
		run: heavy(({ scratch, session }) =>
			timedBesideUnfenced(
				"git clone of cli/cli over https",
				scratch,
				(target) => ({
					script: `git clone -q https://github.com/cli/cli '${target}'`,
					cwd: scratch,
				}),
				session,
			),
		),
	},
];

/**
 * The pre-flight's checks (`fence-preflight.ts`), numbered as in ISXEG8's
 * list of 14 November: the person's paths (1 to 4), agents' (5 to 12),
 * and what stays refused (13 to 15), plus the builders' and the GitHub
 * door's own and git outside a tree while a plant is tried inside.
 *
 * A check that touches the clipboard saves the person's selection first
 * and puts it back after, and works on the primary selection, so nothing
 * he copied is lost (ISXEG8, e0410496).
 */

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NEVER_THROUGH } from "./fence.ts";
import { FENCE_HIDDEN } from "./fence-hidden.ts";
import {
	type Check,
	failed,
	fenced,
	inSession,
	outside,
	type PreflightContext,
	passed,
	refusedAs,
	succeeded,
	tailOf,
	type Verdict,
} from "./fence-preflight.ts";

/** How long a build sent to the builders may take. */
const BUILD_LIMIT_MS = 1_900_000;

/** How long fetching a tool from the cache and running it may take. */
const FETCH_LIMIT_MS = 600_000;

/** The runtime folder, where the person's sockets are. */
function runtime(): string {
	return process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;
}

/** A word no check has used before, for a line, a file or a session. */
function fresh(): string {
	return `preflight-${randomUUID().slice(0, 8)}`;
}

/** The id of the focused window, or nothing when niri doesn't say. */
async function focusedWindow(cwd: string): Promise<number | undefined> {
	const ran = await outside("niri msg -j focused-window", cwd);
	if (ran.code !== 0) return undefined;
	try {
		const window: unknown = JSON.parse(ran.out);
		return typeof window === "object" &&
			window !== null &&
			"id" in window &&
			typeof window.id === "number"
			? window.id
			: undefined;
	} catch {
		// Not JSON: niri answered something else, which says no window.
		return undefined;
	}
}

/** How many windows niri has open, or nothing when it doesn't say. */
async function windowCount(cwd: string): Promise<number | undefined> {
	const ran = await outside("niri msg -j windows", cwd);
	if (ran.code !== 0) return undefined;
	try {
		const windows: unknown = JSON.parse(ran.out);
		return Array.isArray(windows) ? windows.length : undefined;
	} catch {
		// Not JSON: niri answered something else.
		return undefined;
	}
}

/** Check (1): a fenced copy and paste, with the person's selection kept. */
async function clipboardRoundTrip(context: PreflightContext): Promise<Verdict> {
	const { scratch, session } = context;
	const line = fresh();
	const kept = join(scratch, "primary-kept");
	const saved = await outside(
		`wl-paste --primary -n > ${kept} 2>/dev/null`,
		scratch,
	);
	const focusBefore = await focusedWindow(scratch);
	const windowsBefore = await windowCount(scratch);
	try {
		const copy = await fenced(
			`printf %s '${line}' | wl-copy --primary > /dev/null 2>&1`,
			scratch,
			session,
		);
		const paste = await fenced("wl-paste --primary -n", scratch, session);
		const focusAfter = await focusedWindow(scratch);
		const windowsAfter = await windowCount(scratch);
		if (copy.code !== 0) return failed(`wl-copy failed: ${tailOf(copy)}`);
		if (paste.out !== line) {
			return failed(`wl-paste gave back ${JSON.stringify(paste.out)}`);
		}
		if (focusBefore === undefined || focusBefore !== focusAfter) {
			return failed(`focus moved, from ${focusBefore} to ${focusAfter}`);
		}
		if (windowsBefore === undefined || windowsBefore !== windowsAfter) {
			return failed(`windows went from ${windowsBefore} to ${windowsAfter}`);
		}
		return passed(
			`round-tripped on the primary selection in ${copy.ms + paste.ms} ms, focus and windows unchanged`,
		);
	} finally {
		// setsid, so the copy serving his selection outlives this script
		// and anything that stops it.
		await outside(
			saved.code === 0
				? `setsid -f wl-copy --primary < ${kept} > /dev/null 2>&1`
				: "wl-copy --primary --clear",
			scratch,
		);
		rmSync(kept, { force: true });
	}
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
	].filter((path) => existsSync(path));
	const read: string[] = [];
	for (const path of paths) {
		const ran = await fenced(
			`head -c1 '${path}' > /dev/null 2>&1`,
			context.scratch,
			context.session,
		);
		if (ran.code === 0) read.push(path);
	}
	return read.length === 0
		? passed(`${paths.length} hidden files, none readable inside`)
		: failed(`readable inside: ${read.join(", ")}`);
}

/** Check (13b): each socket the fence never lets through is absent inside. */
async function socketsAbsent(context: PreflightContext): Promise<Verdict> {
	const sockets = NEVER_THROUGH.filter((name) => !/[*?]/.test(name))
		.map((name) => join(runtime(), name))
		.filter((path) => existsSync(path));
	const reached: string[] = [];
	for (const path of sockets) {
		const ran = await fenced(
			`test -e '${path}'`,
			context.scratch,
			context.session,
		);
		if (ran.code === 0) reached.push(path);
	}
	return reached.length === 0
		? passed(`${sockets.length} sockets, none there inside`)
		: failed(`there inside: ${reached.join(", ")}`);
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

/** Check (j): git outside a tree finds no redirect while a plant is tried inside. */
async function plantLoop(context: PreflightContext): Promise<Verdict> {
	const home = homedir();
	const root = join(home, "src", `.pi-${fresh()}`);
	const tree = join(context.scratch, "plant-tree");
	try {
		const made = await outside(
			[
				`git init -q '${root}'`,
				`git -C '${root}' -c user.name=p -c user.email=p@p commit -q --allow-empty -m p`,
				`git -C '${root}' worktree add -q '${tree}'`,
			].join(" && "),
			context.scratch,
		);
		if (made.code !== 0) return failed(`no repository: ${tailOf(made)}`);
		const commondir = join(root, ".git", "commondir");
		const planting = fenced(
			`for i in $(seq 50); do printf '%s\\n' /tmp > '${commondir}' 2>/dev/null; sleep 0.05; done; true`,
			tree,
			`${fresh()}-plant`,
			60_000,
		);
		let redirects = 0;
		for (let look = 0; look < 50; look++) {
			const ran = await outside(
				`git -C '${root}' rev-parse --git-common-dir`,
				context.scratch,
			);
			if (ran.out.trim() !== ".git") redirects++;
		}
		await planting;
		const left = existsSync(commondir);
		return redirects === 0 && !left
			? passed("50 looks outside found no redirect, and no commondir was left")
			: failed(`${redirects} redirects seen; commondir left: ${left}`);
	} finally {
		rmSync(join(root, ".git", "commondir"), { force: true });
		rmSync(root, { recursive: true, force: true });
		rmSync(tree, { recursive: true, force: true });
	}
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
		run: async ({ scratch, session }) =>
			succeeded(
				await fenced("gh auth status", scratch, session),
				"gh auth status",
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
		what: "merge-net ready on main's head",
		run: heavy(
			inCoreTree(async (tree, { session }) =>
				succeeded(
					await fenced(
						"merge-net ready $(git rev-parse origin/main)",
						tree,
						session,
						BUILD_LIMIT_MS,
					),
					"merge-net ready",
				),
			),
		),
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
						`gh api graphql -f query='{repository(owner:"cli",name:"cli"){issue(number:1){subIssues(first:1){totalCount}}}}'`,
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
		// keeps a command from the daemon's socket, which takes a yes from
		// anything that reaches it (core's secret-asks daemon.rs). So the
		// asks are checked from outside and the socket from inside, and no
		// ask is ever filed, since one pings Joel.
		run: async ({ scratch, session }) => {
			const socket = join(runtime(), "daemons", "secret-asks.sock");
			const asks = join(runtime(), "secret-asks");
			if (!existsSync(socket)) return failed(`no daemon at ${socket}`);
			if (!existsSync(asks)) return failed(`no asks folder at ${asks}`);
			const inside = await fenced(
				`test -e '${socket}' || test -e '${asks}'`,
				scratch,
				session,
			);
			return inside.code === 0
				? failed("a fenced command reaches the daemon or its asks")
				: passed("its socket and asks are there for pi, and not inside");
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
		what: "keys, the keyring and the builders' key stay hidden",
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
				"npm install of typescript",
				scratch,
				(target) => {
					mkdirSync(target, { recursive: true });
					writeFileSync(join(target, "package.json"), '{"name":"preflight"}');
					return {
						script:
							"npm install --no-save --ignore-scripts --prefer-online typescript@5 > /dev/null",
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

/**
 * E3: two conversations of one host, each on its own quest with its own
 * budget and on its own model, each see only their own in what their
 * bash runs: the budget's name and the variable it lays, their session
 * id, and the commit credit their model earns, which a commit in each
 * one's repository then carries (keying.md 4's done-means). Neither is
 * handed the tools and pi the host's runtime pins for itself, which a
 * newer pi a command starts would otherwise run instead of its own.
 *
 * The budgets come from the harness's own file provider, sealed under
 * XDG_CONFIG_HOME, and each lays a plain variable rather than a model
 * key, since H1 holds a host to one key. Runs on the host's pi, as
 * support/host-pi.ts finds it, skipped saying why without one.
 */

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	textOf,
	toolAnswer,
	untilAnswered,
} from "./support/hosted-case.ts";
import { harnessUnder, sealQuest } from "./support/quests.ts";
import { ACCOUNT, SCRIPTED, SCRIPTED_TOO } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");
/** Stand-ins for the tools the host's runtime pins, as its unit sets them. */
const RUNTIME_TOOLS = {
	AI_PROXY_HEADERS_BIN: "/nix/store/e3-host-runtime/libexec/ai-proxy-headers",
	WORKTRAIL_BIN: "/nix/store/e3-host-runtime/libexec/worktrail",
} as const;
/** What `account` prints, by name. */
const ACCOUNTED =
	/^(PI_BUDGET|E3_KEY|PI_SESSION_ID|PI_CO_AUTHOR|AI_PROXY_HEADERS_BIN|WORKTRAIL_BIN|PI_PACKAGE_DIR)=(.*)$/;

let sealed: Seal;
let host: HostProcess | undefined;
beforeEach(async () => {
	sealed = await seal();
	host = undefined;
});
afterEach(async () => {
	await host?.kill();
	await sealed.dispose();
});

/** What the host wrote, for a failure. */
function said(): string {
	return `The host wrote:\n${host?.errors()}`;
}

/**
 * Seal a budget laying `E3_KEY=key` and a quest drawing on it,
 * answering the quest's id.
 */
async function questOnBudget(name: string, key: string): Promise<string> {
	const budgets = join(harnessUnder(sealed, "XDG_CONFIG_HOME"), "budgets");
	await mkdir(budgets, { recursive: true });
	await writeFile(
		join(budgets, `${name}.env`),
		`# label: ${name}\nE3_KEY=${key}\n`,
	);
	const quest = `QEST-20261109-E3${name.slice(-1).toUpperCase()}000`;
	await sealQuest(sealed, { id: quest, title: name, budget: name });
	return quest;
}

/** A throwaway repository for a conversation to commit in, signing off. */
async function repository(name: string): Promise<string> {
	const folder = join(sealed.home, name);
	await mkdir(folder, { recursive: true });
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: folder, env: sealed.env, stdio: "pipe" });
	git("init", "--quiet");
	git("config", "user.name", "Sealed");
	git("config", "user.email", "sealed@example.invalid");
	git("config", "commit.gpgsign", "false");
	return folder;
}

/** What `account` printed, by variable, and the commit message after. */
function accounted(answer: string): {
	readonly env: ReadonlyMap<string, string>;
	readonly commit: string;
} {
	const env = new Map<string, string>();
	const rest: string[] = [];
	for (const line of answer.split("\n")) {
		const set = ACCOUNTED.exec(line);
		if (set?.[1]) env.set(set[1], set[2] ?? "");
		else rest.push(line);
	}
	return { env, commit: rest.join("\n") };
}

it(
	"E3: each conversation sees only its own budget, session and credit",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const quests = {
				a: await questOnBudget("e3-a", "key-a"),
				b: await questOnBudget("e3-b", "key-b"),
			};
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				// The host's pi and tools, as its unit names them.
				env: { PI_HOST_PACKAGE_DIR: pi, PI_PACKAGE_DIR: pi, ...RUNTIME_TOOLS },
			});
			const a = await host.open(await repository("a"), {
				model: SCRIPTED,
				quest: quests.a,
				first: ACCOUNT,
			});
			const b = await host.open(await repository("b"), {
				model: SCRIPTED_TOO,
				quest: quests.b,
				first: ACCOUNT,
			});
			const answers = async () => {
				await untilAnswered("both conversations account", async () =>
					[a, b].every((one) => toolAnswer(one.file, "bash") !== undefined),
				).catch((error: unknown) => {
					throw new Error(
						`${String(error)}\na: ${textOf(a.file)}\nb: ${textOf(b.file)}`,
					);
				});
				return {
					a: accounted(toolAnswer(a.file, "bash") ?? ""),
					b: accounted(toolAnswer(b.file, "bash") ?? ""),
				};
			};
			const seen = await answers();

			expect(Object.fromEntries(seen.a.env)).toMatchObject({
				PI_BUDGET: "e3-a",
				E3_KEY: "key-a",
				PI_SESSION_ID: a.sessionId,
			});
			expect(Object.fromEntries(seen.b.env)).toMatchObject({
				PI_BUDGET: "e3-b",
				E3_KEY: "key-b",
				PI_SESSION_ID: b.sessionId,
			});
			for (const one of [seen.a, seen.b]) {
				expect(
					Object.fromEntries(one.env),
					"a command finds its own tools and pi",
				).toMatchObject({
					AI_PROXY_HEADERS_BIN: "",
					WORKTRAIL_BIN: "",
					PI_PACKAGE_DIR: "",
				});
			}
			expect(seen.a.env.get("PI_CO_AUTHOR")).toContain("Faux 1");
			expect(seen.b.env.get("PI_CO_AUTHOR")).toContain("Faux 2");
			expect(seen.a.commit).toContain("Co-Authored-By: AI (Faux 1 via Pi)");
			expect(seen.a.commit).not.toContain("Faux 2");
			expect(seen.b.commit).toContain("Co-Authored-By: AI (Faux 2 via Pi)");
			expect(seen.b.commit).not.toContain("Faux 1");
		});
	},
	// The host's start, two opens and a turn each.
	ROUND_TRIP_MS * 2,
);

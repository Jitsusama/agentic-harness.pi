/**
 * Running hosted-session.mts's scenarios in child node processes, as the
 * engine's agent tests do: each scenario in a process of its own, so pi's
 * modules load once, as pi's, and what pi's listeners saw comes back as
 * one JSON line.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const FIXTURE = join(import.meta.dirname, "hosted-session.mts");
/**
 * The longest a scenario that kills its own host may run, under the
 * cases' 60 s budgets: one that never reaches its kill is ended with
 * SIGTERM, so it fails saying so rather than at vitest's timeout, which
 * leaves the process running.
 */
const KILLED_MOST_MS = 45_000;

/** What one scenario showed pi's listeners, and how its agent ended. */
export interface Observed {
	readonly events: readonly {
		readonly type: string;
		/** How long a timed step took, for an event that timed one. */
		readonly ms?: number;
		/** How Joel waits on a run taking a turn to carry on: typing, began or not. */
		readonly waits?: string;
		/** What a step threw, for an event that notes one. */
		readonly error?: string;
		/**
		 * Whether a run was under way at the event: the agent's, once a step
		 * returned, or pi's, as words were sent.
		 */
		readonly streaming?: boolean;
		/** What began a run pi prepared: a person's words, a custom message or a run carried on. */
		readonly trigger?: unknown;
		/** Whether a request carried the fixture's section. */
		readonly sectioned?: boolean;
		/** The sections a request carried, as JSON. */
		readonly prompt?: string;
		/** Whether each tool result in a request follows its call's answer. */
		readonly paired?: boolean;
	}[];
	readonly transcript: readonly {
		readonly role: string;
		readonly content: unknown;
	}[];
	/** How many times the scenario's tool really ran, for a kept session. */
	readonly ran?: number;
	/** The words pi's screen listed as pending once the run ended. */
	readonly pendingAtEnd?: readonly string[];
	/** The messages pi's session log holds, as an extension reads its branch. */
	readonly logged?: readonly unknown[];
	/** The patches of seams the host wants that its pi lacks. */
	readonly lacking?: readonly string[];
	/** Each scan durable's storage made, by its range and how many entries it gave, for a scenario counting them. */
	readonly scans?: readonly {
		readonly minEntryId?: number;
		readonly maxEntryId?: number;
		readonly order?: string;
		readonly items: number;
	}[];
	/** The head of each marker of pi's compaction durable's storage committed, for a scenario noting them. */
	readonly markings?: readonly number[];
}

/** The scenarios' runs on the host's pi, found as each case asks. */
export interface SessionRuns {
	fixtureArgs(
		mode: "pi" | "hosted",
		scenario: string,
		folder?: string,
	): string[];
	/** What pi's listeners saw in one scenario, on pi's agent or the host's. */
	observe(
		mode: "pi" | "hosted",
		scenario: string,
		folder?: string,
	): Promise<Observed>;
	/** Run a hosted scenario to its death, keeping what it left in `folder`; answers the signal that ended it. */
	killed(scenario: string, folder: string): Promise<string | null>;
}

/** A child's environment: none of this session's pi or credentials, only what node needs. */
export function sealedEnv(): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		TMPDIR: process.env.TMPDIR ?? "",
	};
}

/** Scenario runs on the pi `packageDir` names, read as each run starts. */
export function sessionRuns(packageDir: () => string): SessionRuns {
	const fixtureArgs = (
		mode: "pi" | "hosted",
		scenario: string,
		folder?: string,
	): string[] => [
		"--no-warnings",
		FIXTURE,
		packageDir(),
		mode,
		scenario,
		...(folder ? [folder] : []),
	];
	return {
		fixtureArgs,
		async observe(mode, scenario, folder) {
			const { stdout } = await run(
				process.execPath,
				fixtureArgs(mode, scenario, folder),
				{ env: sealedEnv() },
			);
			return JSON.parse(stdout);
		},
		async killed(scenario, folder) {
			try {
				await run(process.execPath, fixtureArgs("hosted", scenario, folder), {
					env: sealedEnv(),
					timeout: KILLED_MOST_MS,
					killSignal: "SIGTERM",
				});
				return null;
			} catch (error) {
				const signal =
					typeof error === "object" && error !== null && "signal" in error
						? error.signal
						: null;
				return typeof signal === "string" ? signal : null;
			}
		},
	};
}

/** A message's text, its parts joined. */
export function textOf(message: { readonly content: unknown }): string {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: unknown) => {
			const text: unknown =
				typeof part === "object" && part !== null
					? Reflect.get(part, "text")
					: undefined;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

/** The text of each message `observed`'s transcript holds in `role`. */
export function said(observed: Observed, role: string): string[] {
	return observed.transcript
		.filter((message) => message.role === role)
		.map(textOf);
}

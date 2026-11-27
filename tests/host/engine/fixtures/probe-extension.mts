// A pi extension hosted-engine.mts copies into a host's agent folder: it notes what a conversation's extensions hear of its start, end and stamp, which conversation each runs as, and the subagent install they find.
/**
 * Copied to `<folder>/home/.pi/agent/extensions/probe.ts`, it writes each
 * line to `<folder>/probe.jsonl`, found from where it sits rather than from
 * HOME, which a conversation's environment need not carry. Its
 * `/tools-probe` command writes every tool the session has, with its
 * exposure and whether it is declared, to `<folder>/tools.jsonl`, the same
 * from a hosted conversation as from a plain pi. Its `/probe-wait` command
 * waits, as a command asking a person does, until the host calls what it
 * leaves at WAIT_RELEASE. First words of ASK_ME are held by its input
 * handler until the person answers a select, as an extension asking
 * before a prompt goes on does. As it loads it says its own record stays
 * in a rolled log's parent, as the harness's records do. It is an .mts, like the
 * programs beside it, because it is copied rather than imported.
 */
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** What the probe reads of a handler's context. */
interface ProbeContext {
	readonly sessionManager: { getSessionId(): string };
	readonly ui: {
		select(title: string, labels: string[]): Promise<string | undefined>;
	};
	newSession(): Promise<{ cancelled: boolean }>;
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
}

/** The few of pi's extension calls the probe makes. */
interface ProbeApi {
	on(
		event: string,
		handler: (
			event: { reason?: string; text?: string },
			context: ProbeContext,
		) => unknown,
	): void;
	registerCommand(
		name: string,
		command: {
			description: string;
			handler: (args: string, context: ProbeContext) => Promise<void>;
		},
	): void;
	getAllTools(): readonly { name: string; exposure: string }[];
	getActiveTools(): readonly string[];
	readonly events: {
		on(
			channel: string,
			handler: (data: { how?: string; why?: string }) => void,
		): void;
		emit(channel: string, data: unknown): void;
	};
}

/** The harness's ambient conversation, as withSession sets it, read without importing the harness. */
const AMBIENT = Symbol.for("agentic-harness.session.ambient.v1");

/** The custom types loads say stay in a rolled log's parent, as rollover.ts keeps them, read without importing the harness. */
const LEFT_BEHIND = Symbol.for("pi:harness:rollover-leaves-behind:v1");

/** The probe's own record, which it says stays behind as the harness's records do. */
const PROBE_RECORD = "probe-record";

/** First words the probe's input handler asks the person about before they go on. */
const ASK_ME = "ask me first";

/** Where `/probe-wait` leaves what ends its wait, for the host in the same process. */
const WAIT_RELEASE = Symbol.for("test-host.probe-wait.release");

const probe = fileURLToPath(
	new URL("../../../../probe.jsonl", import.meta.url),
);
const installs = fileURLToPath(
	new URL("../../../../installs.jsonl", import.meta.url),
);
const tools = fileURLToPath(
	new URL("../../../../tools.jsonl", import.meta.url),
);
const runsAs = fileURLToPath(new URL("../../../../as.jsonl", import.meta.url));

function note(line: Record<string, unknown>): void {
	appendFileSync(probe, `${JSON.stringify(line)}\n`);
}

/** Note the conversation the harness takes this moment to run as, beside the one pi names. */
function noteAs(at: string, id?: string, reason?: string): void {
	const storage: unknown = Reflect.get(globalThis, AMBIENT);
	const getStore: unknown =
		typeof storage === "object" && storage !== null
			? Reflect.get(storage, "getStore")
			: undefined;
	const ambient: unknown =
		typeof getStore === "function"
			? Reflect.apply(getStore, storage, [])
			: undefined;
	appendFileSync(
		runsAs,
		`${JSON.stringify({ at, reason, id, ambient: ambient ?? null })}\n`,
	);
}

/** Note each start, end and stamp of the conversation the probe is loaded in. */
export default function probeExtension(pi: ProbeApi): void {
	// What the subagent library would take as the parent's install, as the extension loads.
	const pinned: unknown = Reflect.get(
		globalThis,
		Symbol.for("pi.subagent.startupPiInstall"),
	);
	appendFileSync(installs, `${JSON.stringify(pinned ?? null)}\n`);
	noteAs("load");
	// As leaveInParentLog says it, so a log held before this load holds it
	// only until the host takes the view again.
	const store = globalThis as Record<symbol, unknown>;
	if (!(LEFT_BEHIND in store)) store[LEFT_BEHIND] = new Set<string>();
	const leftBehind = store[LEFT_BEHIND];
	if (leftBehind instanceof Set) leftBehind.add(PROBE_RECORD);
	pi.on("session_start", (event, context) => {
		note({ event: "session_start", reason: event.reason });
		noteAs(
			"session_start",
			context.sessionManager.getSessionId(),
			event.reason,
		);
	});
	pi.on("session_shutdown", (event, context) => {
		note({ event: "session_shutdown", reason: event.reason });
		noteAs(
			"session_shutdown",
			context.sessionManager.getSessionId(),
			event.reason,
		);
	});
	pi.registerCommand("probe-new", {
		description: "Start a new conversation in place of this one",
		handler: async (_args, context) => {
			// pi's runner says a command's error to the binding, not to the prompt,
			// so the probe notes what the replacement it asked for refused.
			try {
				await context.newSession();
			} catch (error) {
				note({
					event: "new-refused",
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
	});

	pi.registerCommand("probe-switch", {
		description: "Become the conversation another log on disk holds",
		handler: async (args, context) => {
			// pi answers a refused switch, and says a handler's error only to the
			// binding, so either is noted for the step waiting on the switch to
			// stop at once, naming why.
			let cancelled: boolean;
			try {
				({ cancelled } = await context.switchSession(args.trim()));
			} catch (error) {
				note({
					event: "switch-refused",
					to: args.trim(),
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
			if (cancelled) note({ event: "switch-cancelled", to: args.trim() });
		},
	});

	pi.on("input", async (event, context) => {
		if (event.text !== ASK_ME) return { action: "continue" };
		const answer = await context.ui.select("Go on?", ["Yes", "No"]);
		note({ event: "input-asked", answer });
		return answer === "Yes" ? { action: "continue" } : { action: "handled" };
	});

	pi.registerCommand("probe-wait", {
		description:
			"Wait until the host releases it, as a command asking a person does",
		handler: async () => {
			note({ event: "wait-started" });
			await new Promise<void>((release) => {
				Reflect.set(globalThis, WAIT_RELEASE, release);
			});
			note({ event: "wait-ended" });
		},
	});

	pi.events.on("agentic-harness:session-stamp", (stamp) =>
		note({ event: "stamp", how: stamp.how }),
	);
	// A park its host refused after the asking call returned, as the park
	// watch hears it on this conversation's own bus.
	pi.events.on("agentic-harness:park-refused", (refused) =>
		note({ event: "park-refused", why: refused.why }),
	);
	// Background work as a producer hands it off, to the job host on this
	// conversation's bus (job-workflow, where the harness loads), left running,
	// labelled with what follows the command, as a shell job names its command.
	pi.registerCommand("probe-job", {
		description: "Start background work that runs until the session ends",
		handler: async (args) => {
			const label = args.trim() || "held";
			let started = false;
			pi.events.emit("jobs:ask:v1", (host: unknown) => {
				if (started || typeof host !== "object" || host === null) return;
				const start: unknown = Reflect.get(host, "start");
				if (typeof start !== "function") return;
				Reflect.apply(start, host, [{ kind: "probe", label }]);
				started = true;
			});
			note({ event: "job", started: String(started) });
		},
	});
	pi.registerCommand("tools-probe", {
		description: "Note every tool this session has",
		handler: async () => {
			const declared = new Set(pi.getActiveTools());
			const seen = pi
				.getAllTools()
				.map((tool) => ({
					name: tool.name,
					exposure: tool.exposure,
					declared: declared.has(tool.name),
				}))
				.sort((a, b) => a.name.localeCompare(b.name));
			appendFileSync(tools, `${JSON.stringify(seen)}\n`);
		},
	});
}

// A pi extension hosted-engine.mts copies into a host's agent folder: it notes what a conversation's extensions hear of its start, end and stamp, which conversation each runs as, and the subagent install they find.
/**
 * Copied to `<folder>/home/.pi/agent/extensions/probe.ts`, it writes each
 * line to `<folder>/probe.jsonl`, found from where it sits rather than from
 * HOME, which a conversation's environment need not carry. Its
 * `/tools-probe` command writes every tool the session has, with its
 * exposure and whether it is declared, to `<folder>/tools.jsonl`, the same
 * from a hosted conversation as from a plain pi. Its `/probe-wait` command
 * waits, as a command asking a person does, until the host calls what it
 * leaves at WAIT_RELEASE. It is an .mts, like the
 * programs beside it, because it is copied rather than imported.
 */
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** What the probe reads of a handler's context. */
interface ProbeContext {
	readonly sessionManager: { getSessionId(): string };
	newSession(): Promise<{ cancelled: boolean }>;
}

/** The few of pi's extension calls the probe makes. */
interface ProbeApi {
	on(
		event: string,
		handler: (event: { reason?: string }, context: ProbeContext) => void,
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
		on(channel: string, handler: (data: { how?: string }) => void): void;
	};
}

/** The harness's ambient conversation, as withSession sets it, read without importing the harness. */
const AMBIENT = Symbol.for("agentic-harness.session.ambient.v1");

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
			await context.newSession();
		},
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

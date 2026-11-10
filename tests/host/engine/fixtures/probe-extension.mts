// A pi extension hosted-engine.mts copies into a host's agent folder: it notes what a conversation's extensions hear of its start, end and stamp, and the subagent install they find.
/**
 * Copied to `<folder>/home/.pi/agent/extensions/probe.ts`, it writes each
 * line to `<folder>/probe.jsonl`, found from where it sits rather than from
 * HOME, which a conversation's environment need not carry. It is an .mts,
 * like the programs beside it, because it is copied rather than imported.
 */
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The few of pi's extension calls the probe makes. */
interface ProbeApi {
	on(event: string, handler: (event: { reason?: string }) => void): void;
	readonly events: {
		on(channel: string, handler: (data: { how?: string }) => void): void;
	};
}

const probe = fileURLToPath(
	new URL("../../../../probe.jsonl", import.meta.url),
);
const installs = fileURLToPath(
	new URL("../../../../installs.jsonl", import.meta.url),
);

function note(line: Record<string, unknown>): void {
	appendFileSync(probe, `${JSON.stringify(line)}\n`);
}

/** Note each start, end and stamp of the conversation the probe is loaded in. */
export default function probeExtension(pi: ProbeApi): void {
	// What the subagent library would take as the parent's install, as the extension loads.
	const pinned: unknown = Reflect.get(
		globalThis,
		Symbol.for("pi.subagent.startupPiInstall"),
	);
	appendFileSync(installs, `${JSON.stringify(pinned ?? null)}\n`);
	pi.on("session_start", (event) =>
		note({ event: "session_start", reason: event.reason }),
	);
	pi.on("session_shutdown", (event) =>
		note({ event: "session_shutdown", reason: event.reason }),
	);
	pi.events.on("agentic-harness:session-stamp", (stamp) =>
		note({ event: "stamp", how: stamp.how }),
	);
}

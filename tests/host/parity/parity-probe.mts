// A pi extension the parity test gives both sides: it registers the scripted provider, writes every event pi's extensions hear, and adds one command.
/**
 * Copied to `<scenario>/probe.ts` and loaded as `-e` loads one. It reads
 * `parity.json` from the working folder for the provider's endpoint and the
 * trace file, and writes each event as one JSON line, so the two sides'
 * traces can be compared event by event. It is an .mts, like the programs
 * beside it, because it is copied rather than imported.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The few of pi's extension calls the probe makes. */
interface ProbeApi {
	registerProvider(name: string, provider: object): void;
	on(event: string, handler: (event: unknown) => void): void;
	getAllTools(): unknown;
	getActiveTools(): unknown;
	registerCommand(
		name: string,
		command: {
			description: string;
			handler: (args: string) => Promise<void>;
		},
	): void;
	appendEntry(type: string, data: unknown): void;
}

/** What the test writes for the probe to find. */
interface ParityConfig {
	readonly endpoint: string;
	readonly trace: string;
}

/** Every event the probe traces. */
const EVENTS = [
	"session_start",
	"resources_discover",
	"session_shutdown",
	"input",
	"before_agent_start",
	"agent_start",
	"turn_start",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_call",
	"tool_result",
	"tool_execution_update",
	"tool_execution_end",
	"turn_end",
	"agent_end",
	"agent_before_settle",
	"agent_settled",
	"context",
	"context_with_system",
	"before_provider_request",
	"before_provider_headers",
	"after_provider_response",
	"provider_stream_event",
	"session_before_compact",
	"session_compact",
	"session_compact_failed",
];

export default function parityProbe(pi: ProbeApi): void {
	const config: ParityConfig = JSON.parse(
		readFileSync(join(process.cwd(), "parity.json"), "utf8"),
	);
	const record = (event: unknown) =>
		appendFileSync(
			config.trace,
			`${JSON.stringify(event, (_key, value) =>
				typeof value === "bigint" ? String(value) : value,
			)}\n`,
		);
	pi.registerProvider("parity", {
		baseUrl: config.endpoint,
		apiKey: "local-parity-no-secret",
		api: "anthropic-messages",
		models: [
			{
				id: "mock",
				name: "Parity Mock",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8192,
			},
		],
	});
	for (const name of EVENTS) pi.on(name, record);
	pi.on("session_start", () =>
		record({
			type: "tool_registry",
			tools: pi.getAllTools(),
			active: pi.getActiveTools(),
		}),
	);
	pi.registerCommand("parity-ping", {
		description: "Parity suite command, no model request",
		handler: async (args) => {
			pi.appendEntry("parity-command", { args });
			record({ type: "command_executed", args });
		},
	});
}

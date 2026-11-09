/** One-shot control client; never retries a possibly committed mutation. */
import { createConnection } from "node:net";
import { jsonLines } from "./framing.ts";
import { type ControlRequest, parseControl, parseReply } from "./protocol.ts";

const REQUEST_TIMEOUT_MS = 30_000;

/** Send one control request and verify reply correlation; attach needs V's streaming client. */
export async function controlRequest(
	path: string,
	value: ControlRequest,
	timeoutMs = REQUEST_TIMEOUT_MS,
) {
	const request = parseControl(value);
	if (
		["close", "release", "abort"].includes(request.op) &&
		!request.expectedHost
	)
		throw new Error(
			"Session-ending requests require expectedHost discovery identity",
		);
	if (request.op === "attach")
		throw new Error("Attach requires a streaming viewer client");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
		throw new Error("Control timeout must be a positive integer");
	return new Promise<ReturnType<typeof parseReply>>((resolve, reject) => {
		const socket = createConnection(path);
		const frames = jsonLines();
		let settled = false;
		const deadline = setTimeout(
			() => fail(new Error("Host control request timed out; outcome unknown")),
			timeoutMs,
		);
		function fail(error: unknown) {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			socket.destroy();
			reject(error);
		}

		socket.on("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (chunk) => {
			try {
				const values = frames.push(
					typeof chunk === "string" ? Buffer.from(chunk) : chunk,
				);
				if (!values.length) return;
				if (values.length !== 1)
					throw new Error("Host sent multiple control replies");
				const reply = parseReply(values[0]);
				if (reply.id !== request.id)
					throw new Error("Host reply id does not match request");
				settled = true;
				clearTimeout(deadline);
				socket.destroy();
				resolve(reply);
			} catch (error) {
				fail(error);
			}
		});
		socket.on("error", fail);
		socket.on("close", () =>
			fail(new Error("Host closed before reply; outcome unknown")),
		);
	});
}

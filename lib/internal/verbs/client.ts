/**
 * A thin client of the verbs server, for agents and tests: one line
 * asked, its answer read, the connection closed. The launcher keeps its
 * own connection open instead.
 */

import { connect } from "node:net";

/** How long an answer may take before the server is taken as wedged. */
const ANSWER_MS = 5000;

/**
 * The verbs server's answer to `line`, asked under id 1 on a connection
 * of its own; refused when nothing listens or nothing answers in time.
 */
export function askVerbs(
	socket: string,
	line: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const connection = connect(socket);
		let held = "";
		const timer = setTimeout(() => {
			connection.destroy();
			reject(
				new Error(
					`the verbs server at ${socket} didn't answer in ${ANSWER_MS / 1000} s`,
				),
			);
		}, ANSWER_MS);
		connection.setEncoding("utf8");
		connection.on("connect", () =>
			connection.write(`${JSON.stringify({ ...line, id: 1 })}\n`),
		);
		connection.on("data", (data: string) => {
			held += data;
			const end = held.indexOf("\n");
			if (end < 0) return;
			clearTimeout(timer);
			connection.destroy();
			try {
				resolve(JSON.parse(held.slice(0, end)));
			} catch (error) {
				reject(
					new Error(
						`the verbs server answered something not JSON: ${String(error)}`,
					),
				);
			}
		});
		connection.on("error", (error) => {
			clearTimeout(timer);
			reject(
				new Error(
					`the verbs server isn't running at ${socket}: ${error.message}`,
				),
			);
		});
	});
}

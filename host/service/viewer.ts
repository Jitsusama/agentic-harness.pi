/** Adapt V's persistent Terminal to H2's framed socket; do not recreate its input parser. */
import type { ViewerTerminal } from "../../lib/core/viewer/terminal.ts";
import type { ViewerBridge } from "./server.ts";

/** Look up an existing session Terminal and attach only a new connection's sink. */
export function terminalBridge(
	lookup: (sessionId: string) => ViewerTerminal,
): ViewerBridge {
	return {
		attach: (request, sink) => {
			const terminal = lookup(request.sessionId);
			if (terminal.sessionId !== request.sessionId)
				throw new Error("Viewer Terminal belongs to a different session");
			return terminal.attach({
				rows: request.rows,
				columns: request.columns,
				features: request.features ?? [],
				...(request.window ? { window: request.window } : {}),
				...sink,
			});
		},
	};
}

/**
 * The same bridge, telling `noticed` of each key and resize a viewer
 * sends, before the screen takes it.
 */
export function noticingInput(
	bridge: ViewerBridge,
	noticed: () => void,
): ViewerBridge {
	return {
		attach: (request, sink) => {
			const connection = bridge.attach(request, sink);
			return {
				edited: (id, text) => connection.edited?.(id, text),
				detach: () => connection.detach(),
				input: (data) => {
					noticed();
					connection.input(data);
				},
				resize: (rows, columns) => {
					noticed();
					connection.resize(rows, columns);
				},
			};
		},
	};
}

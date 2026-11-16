/**
 * pi's declareToolChanges: what tools changed since the transcript last
 * said, told the model in a system message, as pi's own agent tells it.
 */
import type { PiLibrary } from "../pi-library.ts";
import type { AgentContext, AgentMessage } from "../pi-types.ts";

/** pi's declareToolChanges: tell the model what tools changed since the transcript last said. */
export function declareToolChanges(
	library: PiLibrary,
	context: AgentContext,
	pending: AgentMessage[],
): AgentMessage[] {
	let systemIndex = -1;
	for (let index = pending.length - 1; index >= 0; index--) {
		if (pending[index]?.role === "system") {
			systemIndex = index;
			break;
		}
	}
	const system = systemIndex >= 0 ? pending[systemIndex] : undefined;
	const noChanges = { toolsAdded: [], toolsRemoved: [] };
	const baseline = system
		? pending.map((message, index) =>
				index === systemIndex ? withToolChanges(message, noChanges) : message,
			)
		: pending;
	const changes = library.getToolStateChanges(
		library.getCurrentTools([...context.messages, ...baseline]),
		(context.tools ?? []).map(library.toToolDeclaration),
	);
	const unchanged =
		changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;
	if (system) {
		const declares = (field: unknown) =>
			Array.isArray(field) && field.length > 0;
		if (
			unchanged &&
			!declares(system.toolsAdded) &&
			!declares(system.toolsRemoved)
		)
			return pending;
		return baseline.map((message, index) =>
			index === systemIndex ? withToolChanges(system, changes) : message,
		);
	}
	if (unchanged) return pending;
	const update = withToolChanges(
		{ role: "system", content: "", timestamp: Date.now() },
		changes,
	);
	const insert = pending.findIndex((message) => message.role !== "system");
	const at = insert === -1 ? pending.length : insert;
	return [...pending.slice(0, at), update, ...pending.slice(at)];
}

function withToolChanges(
	message: AgentMessage,
	changes: {
		readonly toolsAdded: readonly unknown[];
		readonly toolsRemoved: readonly unknown[];
	},
): AgentMessage {
	const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
	return {
		...rest,
		role: message.role,
		...(changes.toolsAdded.length > 0
			? { toolsAdded: changes.toolsAdded }
			: {}),
		...(changes.toolsRemoved.length > 0
			? { toolsRemoved: changes.toolsRemoved }
			: {}),
	};
}

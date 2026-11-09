/** Control dispatch delegates session semantics to the engine, never pi replicas. */
import { withSession } from "../../lib/core/session/index.ts";
import { type ControlRequest, parseControl } from "./protocol.ts";

/** Engine boundary for validated operations; transport owns no AgentSession. */
export interface ControlBackend {
	readonly identity: NonNullable<ControlRequest["expectedHost"]>;
	execute(request: ControlRequest): Promise<unknown>;
}

/** A correlated reply, with no incoming payload or internal exception in errors. */
export type ControlReply =
	| { v: 1; id: string; ok: true; result: unknown }
	| {
			v: 1;
			id: string | null;
			ok: false;
			error: { code: string; message: string };
	  };

/** Validate before invoking the engine and bind targeted calls to their session. */
export async function dispatchControl(
	value: unknown,
	backend: ControlBackend,
	report?: (error: unknown) => void,
): Promise<ControlReply> {
	let request: ControlRequest;
	try {
		request = parseControl(value);
	} catch {
		return {
			v: 1,
			id: null,
			ok: false,
			error: {
				code: "invalid_request",
				message: "Invalid host control request",
			},
		};
	}
	if (request.expectedHost) {
		const expected = request.expectedHost;
		const actual = backend.identity;
		if (
			expected.key !== actual.key ||
			expected.owner.pid !== actual.owner.pid ||
			expected.owner.startedAt !== actual.owner.startedAt ||
			expected.owner.bootId !== actual.owner.bootId ||
			expected.owner.startTicks !== actual.owner.startTicks
		) {
			return {
				v: 1,
				id: request.id,
				ok: false,
				error: {
					code: "stale_host",
					message: "Host identity changed; refresh discovery",
				},
			};
		}
	}
	try {
		const result =
			"sessionId" in request
				? await withSession(request.sessionId, () => backend.execute(request))
				: await backend.execute(request);
		// JSON drops an undefined field, and a reply without result is
		// invalid, so a backend that answers nothing still answers null.
		return { v: 1, id: request.id, ok: true, result: result ?? null };
	} catch (error) {
		report?.(error);
		return {
			v: 1,
			id: request.id,
			ok: false,
			error: {
				code: "operation_failed",
				message: "Host operation failed; inspect the host journal",
			},
		};
	}
}

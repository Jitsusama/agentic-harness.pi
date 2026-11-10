/**
 * A provider stream opened a second time when the gateway refused the key it
 * was opened with. A host outlives the key it started with: the gateway key
 * renews about daily, and a request sent on the old one fails with nothing
 * streamed. pi's own retry leaves an authentication failure alone, so the
 * person would see the refusal although a fresh key was a moment away.
 * Providers say a refusal as their first event, before any of the answer,
 * so opening once more shows nothing twice.
 */
import type {
	AssistantMessage,
	ProviderEvent,
	ProviderStream,
} from "./pi-types.ts";

/**
 * Open a stream; if its first event is an error `renewed` says came from a
 * key it has since renewed, open it once more and answer with that one.
 * Any other first event is kept and the stream answered as it is.
 */
export async function openRenewing(
	open: () => Promise<ProviderStream>,
	renewed: (error: AssistantMessage) => Promise<boolean>,
): Promise<ProviderStream> {
	const stream = await open();
	const events = stream[Symbol.asyncIterator]();
	const first = await events.next();
	if (
		!first.done &&
		first.value.type === "error" &&
		first.value.error &&
		(await renewed(first.value.error))
	) {
		await events.return?.();
		return open();
	}
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
			if (first.done) return;
			yield first.value;
			for (
				let next = await events.next();
				!next.done;
				next = await events.next()
			)
				yield next.value;
		},
		result: () => stream.result(),
	};
}

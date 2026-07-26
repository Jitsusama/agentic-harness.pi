/**
 * Telemetry: what the page did while nobody was looking.
 *
 * Buffers here are plain data structures over serializable
 * entries, so a record captured from CDP, from a fixture or
 * from another driver is read the same way.
 */

export {
	type BufferLimits,
	createRingBuffer,
	type Recorded,
	type RingBuffer,
} from "./buffer.js";
export {
	type BrowserLogged,
	browserEntry,
	type CallFrame,
	type ConsoleCalled,
	consoleEntry,
	consoleText,
	type ExceptionThrown,
	exceptionEntry,
	type LogEntry,
	type RemoteArg,
	type RemotePreview,
	type RemotePreviewProperty,
	renderArg,
} from "./console.js";
export {
	answerFor,
	DEFAULT_DIALOG_POLICY,
	type DialogEvent,
	type DialogKind,
	type DialogPolicy,
	renderDialogs,
} from "./dialogs.js";
export {
	createDownloadRecorder,
	type DownloadInput,
	type DownloadRecord,
	type DownloadRecorder,
	type DownloadState,
	renderDownloads,
} from "./downloads.js";
export {
	type Har,
	type HarEntry,
	type HarOptions,
	type HarPair,
	type HarTimings,
	toHar,
} from "./har.js";
export {
	createLifecycleRecorder,
	type LifecycleEvent,
	type LifecycleInput,
	type LifecycleKind,
	type LifecycleRecorder,
	renderLifecycle,
} from "./lifecycle.js";
export {
	createNetworkRecorder,
	type LoadingFailed,
	type LoadingFinished,
	type NetworkEvent,
	type NetworkRecorder,
	type NetworkRequest,
	type RedirectHop,
	type RequestSent,
	type RequestState,
	type ResourceTiming,
	type ResponseReceived,
} from "./network.js";
export { type RequestQuery, renderRequests } from "./requests.js";
export { type Captured, renderLogs } from "./view.js";

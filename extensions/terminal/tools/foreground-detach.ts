import type { TerminalRuntimeSession } from "../runtime-session.ts";

export interface ForegroundDetachGateOptions {
	readonly runtime: TerminalRuntimeSession;
	readonly signal: AbortSignal | undefined;
	readonly delayMs: number;
	/** Removes the foreground abort listener at the detach linearization point. */
	readonly removeAbortListener: () => void;
}

export interface ForegroundDetachGate {
	/** Resolves only after detach has committed; it remains pending when exit or abort wins. */
	readonly detached: Promise<void>;
	cancel(): void;
}

/**
 * Race a foreground command's cache deadline against exit and abort without
 * introducing an observable gap between the final checks and promotion. The
 * native session's `onExit` calls already-settled listeners, which makes the
 * listener registration a linearization gate rather than a best-effort peek.
 */
export function createForegroundDetachGate(options: ForegroundDetachGateOptions): ForegroundDetachGate {
	let cancelled = false;
	let committed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let resolveDetached!: () => void;
	const detached = new Promise<void>((resolve) => {
		resolveDetached = resolve;
	});

	const clearDeadline = () => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
	};

	const linearize = () => {
		if (cancelled || committed || options.runtime.exited) return;
		if (options.signal?.aborted) return;

		let exitedAtGate = false;
		const unsubscribeExit = options.runtime.session.onExit(() => {
			if (!committed) exitedAtGate = true;
		});
		if (cancelled || options.runtime.exited || exitedAtGate || options.signal?.aborted) {
			unsubscribeExit();
			return;
		}

		committed = true;
		options.removeAbortListener();
		unsubscribeExit();
		resolveDetached();
	};

	timer = setTimeout(() => queueMicrotask(linearize), options.delayMs);
	return {
		detached,
		cancel() {
			cancelled = true;
			clearDeadline();
		},
	};
}

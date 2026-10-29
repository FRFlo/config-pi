import { describe, expect, it } from "vitest";
import { notifyOm } from "../src/ui/notify.js";

describe("notifyOm", () => {
	it("suppresses routine info notifications in Pi RPC mode", () => {
		const messages: unknown[][] = [];
		const ctx = { mode: "rpc", ui: { notify: (...args: unknown[]) => messages.push(args) } };

		notifyOm(ctx, "observer started", "info");

		expect(messages).toEqual([]);
	});

	it("preserves warnings and errors in Pi RPC mode", () => {
		const messages: unknown[][] = [];
		const ctx = { mode: "rpc", ui: { notify: (...args: unknown[]) => messages.push(args) } };

		notifyOm(ctx, "worker failed", "error");
		notifyOm(ctx, "check configuration", "warning");

		expect(messages).toEqual([
			["worker failed", "error"],
			["check configuration", "warning"],
		]);
	});

	it("keeps Pi TUI info notifications and explicit RPC status output", () => {
		const messages: unknown[][] = [];
		const tui = { mode: "tui", ui: { notify: (...args: unknown[]) => messages.push(args) } };
		const rpc = { mode: "rpc", ui: { notify: (...args: unknown[]) => messages.push(args) } };

		notifyOm(tui, "observer started", "info");
		notifyOm(rpc, "om status", "info", { showInfoInRpc: true });

		expect(messages).toEqual([
			["observer started", "info"],
			["om status", "info"],
		]);
	});
});

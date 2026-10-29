import { describe, expect, it } from "bun:test";
import { resolveRpcSelection } from "./hermes-rpc";

describe("resolveRpcSelection", () => {
	it("preserves a recognized option's index", () => {
		expect(resolveRpcSelection("Blue", ["Red", "Blue"])).toEqual({ kind: "option", index: 1 });
	});

	it("treats an unlisted RPC answer as a custom Other value", () => {
		expect(resolveRpcSelection("My custom answer", ["Red", "Blue"])).toEqual({
			kind: "other",
			value: "My custom answer",
		});
	});

	it("keeps cancellation distinct from custom text", () => {
		expect(resolveRpcSelection(undefined, ["Red", "Blue"])).toBeNull();
	});
});

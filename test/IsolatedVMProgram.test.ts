import { default as assert } from "node:assert";
import { describe, it, mock } from "node:test";
import { IsolatedVMProgram } from "../src/IsolatedVMProgram.js";

function sources(sourceMap: Record<string, string>) {
	return (file: string) => sourceMap[file];
}


describe("test program", async () => {
	it("simple methods", async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				export function increment(x){
					return x+1;
				}
				export async function asyncIncrement(x){
					await new Promise(r => setTimeout(r, 1));
					return x+1;
				}
				export function throwIncrement(x){
					throw x+1;
				}
				export async function throwAsyncIncrement(x){
					await new Promise(r => setTimeout(r, 1));
					throw x+1;
				}
				export async function throwAsyncPromiseIncrement(x){
					throw asyncIncrement(x);
				}
				export async function throwAsyncRejectIncrement(x){
					throw throwAsyncIncrement(x);
				}
			`
		})

		const program = new IsolatedVMProgram(sourceConfig);
		const indexModule = await program.createModule("index.js");

		const result1 = await indexModule.callMethod("increment", undefined, 10);
		assert.equal(result1, 11);
	});
});
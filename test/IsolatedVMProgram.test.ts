import { default as assert } from "node:assert";
import { describe, it, mock } from "node:test";
import { IsolatedVMProgram } from "../src/IsolatedVMProgram.js";
import { parseDescriptor } from "../src/util/DescriptorUtils.js";


function sources(sourceMap: Record<string, string>) {
	return (specifier: string) => {
		const desc = parseDescriptor(specifier);
		if (desc.protocol) return {
			name: specifier,
			getSource: async () => {
				const response = await fetch(specifier);
				if (!response.ok) throw response;
				return {
					type: response.headers.get("content-type"),
					text: await response.text(),
				}
			},
		}
		if (desc.file in sourceMap) return {
			name: specifier,
			getSource: () => ({
				type: desc.extension,
				text: sourceMap[specifier]
			})
		}
		return undefined;
	}
}

describe("test program", {timeout: 3500},async () => {
	await it("simple methods", async () => {
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
			`
		});

		using program = new IsolatedVMProgram(sourceConfig);
		const indexModule = await program.getModule("index.js");

		const result1 = await indexModule.callMethod("increment", undefined, 10);
		assert.equal(result1, 11);
		const result2 = await indexModule.callMethod("asyncIncrement", undefined, 20);
		assert.equal(result2, 21);
		await assert.rejects(indexModule.callMethod("throwIncrement", undefined, 30), e => e === 31);
		await assert.rejects(indexModule.callMethod("throwAsyncIncrement", undefined, 40), e => e === 41);

	});

	await it("cross import js", {timeout: 3500}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				import { x } from "other.js";
				export function test(){
					return x + 100;
				}
			`,
			"other.js": /* language=JavaScript */ `
				export const x = 10;
			`,
		});

		using program = new IsolatedVMProgram(sourceConfig);
		const indexModule = await program.getModule("index.js");

		const result1 = await indexModule.callMethod("test");
		assert.equal(result1, 110);
	});

	await it("cross import json", {timeout: 3500}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				import value from "other.json";
				export function test(){
					return value.items[2];
				}
			`,
			"other.json": /* language=JSON */ `
              {"items": [0, 100, 200]}
			`,
		});

		using program = new IsolatedVMProgram(sourceConfig);
		const indexModule = await program.getModule("index.js");

		const result1 = await indexModule.callMethod("test");
		assert.equal(result1, 200);
	});

	await it("remote module", {timeout: 3500}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
                import {createStore} from 'https://cdn.jsdelivr.net/npm/effector@23.2.2/+esm'
				export function test(){
					return typeof createStore;
				}
			`,
		});

		using program = new IsolatedVMProgram(sourceConfig);
		const indexModule = await program.getModule("index.js");

		const result1 = await indexModule.callMethod("test");
		assert.equal(result1, "function");
	});

	await it("deadlocks", {timeout: 3500}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				export function cycle(x){while (x --> 0){}}
			`
		});

		using program = new IsolatedVMProgram(sourceConfig);
		const indexModule = await program.getModule("index.js");
		await indexModule.callMethod("cycle", null, 1, "no deadlock in 1");
		await indexModule.callMethod("cycle", null, 100, "no deadlock in 100");
		await indexModule.callMethod("cycle", null, 1000, "no deadlock in 1000");
		await assert.rejects(
			indexModule.callMethod("cycle", null, Infinity),
			(e) =>  e instanceof Error
		);
		assert.ok(program.isDisposed);
	})

	await it("deadlocks async", {timeout: 3500}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				export async function asyncCycle(x){while (x --> 0){}}
			`
		});

		using program = new IsolatedVMProgram(sourceConfig);
		const indexModule = await program.getModule("index.js");
		await indexModule.callMethod("asyncCycle", null, 1, "no deadlock in 1");
		await indexModule.callMethod("asyncCycle", null, 100, "no deadlock in 100");
		await indexModule.callMethod("asyncCycle", null, 1000, "no deadlock in 1000");
		await assert.rejects(
			indexModule.callMethod("asyncCycle", null, Infinity),
			(e) =>  e instanceof Error
		);
		assert.ok(program.isDisposed);
	});

	await it("deadlocks memo 8mb", {timeout: 3500}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				export async function test(x){
                    const storage = [];
                    const megabyteSize = 1024 * 1024;
                    while (x --> 0) {
                        const array = new Uint8Array(megabyteSize);
                        for (let ii = 0; ii < megabyteSize; ii += 4096) array[ii] = 1;
                        storage.push(array);
                    }
                    void storage;
				}
			`
		});

		using program = new IsolatedVMProgram(sourceConfig, {memoryLimitMb: 8});
		const indexModule = await program.getModule("index.js");
		await indexModule.callMethod("test", null, 1, "no memory leak in 1mb");
		await indexModule.callMethod("test", null, 4, "no memory leak in 4mb");
		await assert.rejects(
			indexModule.callMethod("test", null, 12, "memory leak in 12mb"),
			(e) => e instanceof Error,
		);
		await indexModule.callMethod("test", null, 2, "no memory leak in 2mb");
	});

	await it("deadlocks memo 128mb", {timeout: 3500}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				export async function test(x){
                    const storage = [];
                    const megabyteSize = 1024 * 1024;
                    while (x --> 0) {
                        const array = new Uint8Array(megabyteSize);
                        for (let ii = 0; ii < megabyteSize; ii += 4096) array[ii] = 1;
                        storage.push(array);
                    }
                    void storage;
				}
			`
		});

		using program = new IsolatedVMProgram(sourceConfig, {memoryLimitMb: 128});
		const indexModule = await program.getModule("index.js");
		await indexModule.callMethod("test", null, 100, "no memory leak in 100mb");
		await assert.rejects(
			indexModule.callMethod("test", null, 140, "memory leak in 140mb"),
			(e) => e instanceof Error,
		);
		await indexModule.callMethod("test", null, 90, "no memory leak in 90mb");
	});

	await it("simple inner module", {timeout: 3500}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `export * from "#inner";`,
			"index.js#inner": /* language=JavaScript */ `export const name = "index-inner";`,
			"evil.js": /* language=JavaScript */ `export * from "holy.js#inner";`,
			"holy.js#inner": /* language=JavaScript */ `export const name = "holy-inner";`
		});

		using program = new IsolatedVMProgram(sourceConfig);
		const indexModule = await program.getModule("index.js");
		assert.equal(await indexModule.getProp("name"), "index-inner");
		await assert.rejects(program.getModule("evil.js"));
	});

	await it("create module", {timeout: 3500}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
                import { outer } from "test:outer";
                export function test(){
                    return outer.value;
                }
			`
		});

		using program = new IsolatedVMProgram(sourceConfig);
		void program.createModule("test:outer", `export const outer = {value: 10}`, 'js');
		const indexModule = await program.getModule("index.js");
		assert.equal(await indexModule.callMethod("test", null), 10);
	})


	await it("create module json", {timeout: 3500}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				import config from "test:config";
				export function test(){
    				return config.value;
				}
			`
		});

		using program = new IsolatedVMProgram(sourceConfig);
		void program.createModule("test:config", `{"value": 20}`, 'json');
		const indexModule = await program.getModule("index.js");
		assert.equal(await indexModule.callMethod("test", null), 20);
	});

	await it("clear all timers", {timeout: 3500}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
                let i=0;
                setInterval(() => {
                    i++;
                }, 10);
			`
		});

		using program = new IsolatedVMProgram(sourceConfig);
		await program.getModule("index.js");
	})
	
	await it("disposable with inspector", {timeout: 3500}, async () => {
		const sourceConfig = sources({"index.js": /* language=JavaScript */ `console.log('1')`});
		const program = new IsolatedVMProgram(sourceConfig, {inspector: true});
		const inspector1 = program.createInspectorSession();
		const inspector2 = program.createInspectorSession();
		const inspector3 = program.createInspectorSession();
		inspector1.dispose();
		assert.ok(inspector1.isDisposed, "inspector1 is not disposed");
		program.dispose();
		assert.ok(program.isDisposed, "program is not disposed");
		assert.ok(inspector2.isDisposed, "inspector2 is not disposed");
		assert.ok(inspector3.isDisposed, "inspector3 is not disposed");
	})
});
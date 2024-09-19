import { IsolatedVMProgram } from "./IsolatedVMProgram.js";
import IVM from "isolated-vm";

export class PerformanceModuleHelper {
	readonly #initTime: number;
	readonly #program: IsolatedVMProgram;
	readonly #moduleName: string;
	
	getNow = () => performance.now() - this.#initTime;
	
	constructor(program: IsolatedVMProgram, moduleName: string) {
		this.#initTime = performance.now();
		this.#program = program;
		this.#moduleName = moduleName;
	}
	
	async execute(){
		const innerModule = await this.#program.createModule(
			`${this.#moduleName}#inner`,
			"export let now; export const $set = s => {now = s};",
		);
		await innerModule.callMethod("$set", undefined, new IVM.Callback(this.getNow));
		await this.#program.createModule(this.#moduleName, `export { now } from "#inner";`);
	}
}
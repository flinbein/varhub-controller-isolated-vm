import type { ApiHelperController, PlayerController, Room } from "@flinbein/varhub";
import { IsolatedVMProgram } from "./IsolatedVMProgram.js";
import IVM from "isolated-vm";

const EVENT_EMITTER_MODULE_NAME = "@varhub/EventEmitter";
export class ApiModuleHelper {
	readonly #apiHelperController: ApiHelperController | undefined;
	readonly #apiPrefix: string;
	readonly #program: IsolatedVMProgram;
	
	constructor(apiCtrl: ApiHelperController | undefined, program: IsolatedVMProgram, apiPrefix: string) {
		this.#apiPrefix = apiPrefix;
		this.#program = program;
		this.#apiHelperController = apiCtrl;
	}
	
	async execute(){
		const innerModule = await this.#program.createModule(
			this.#apiPrefix+"#inner",
			// language=JavaScript
			`export let $; export const set = a => {$ = a}`
		);
		innerModule.callMethodIgnored("set", undefined, this.#program.createMaybeAsyncFunctionDeref(this.callApi, {release: true}));
	}
	
	getPossibleApiModuleName(file: string){
		if (file.startsWith(this.#apiPrefix)) return file.substring(this.#apiPrefix.length);
	}
	
	createApiSource(apiName: string, program: IsolatedVMProgram): string | void {
		const api = this.#apiHelperController?.getOrCreateApi(apiName);
		if (!api) return;
		const methods = Object.getOwnPropertyNames(api);
		
		// language=JavaScript
		const innerModuleCode = `
			import {$} from ${JSON.stringify(this.#apiPrefix+"#inner")};
			const createMethod = (name) => (...args) => $(${JSON.stringify(apiName)}, name, ...args);
			export default Object.freeze({
				${methods.map((methodName) => (
                    // language=JavaScript prefix="export default {" suffix="}"
					`[${JSON.stringify(methodName)}]: createMethod(${JSON.stringify(methodName)})`
				)).join(",")}
			});
		`
		program.setBuiltinModuleName(this.#apiPrefix + apiName, true);
		return innerModuleCode;
	}
	
	callApi = (apiName: unknown, method: unknown, ...args: unknown[]) => {
		const api = this.#apiHelperController?.getApi(String(apiName));
		if (!api) throw new Error(`api not initialized: ${apiName}`);
		const methodName = String(method);
		const methods = Object.getOwnPropertyNames(api);
		if (!methods.includes(methodName))  throw new Error(`api has no method: ${methodName}`);
		return api[methodName]?.(...args);
	}
}
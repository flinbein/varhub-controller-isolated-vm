const EVENT_EMITTER_MODULE_NAME = "@varhub/EventEmitter";
export class ApiModuleHelper {
    #apiHelperController;
    #apiPrefix;
    #program;
    constructor(apiCtrl, program, apiPrefix) {
        this.#apiPrefix = apiPrefix;
        this.#program = program;
        this.#apiHelperController = apiCtrl;
    }
    async execute() {
        const innerModule = await this.#program.createModule(this.#apiPrefix + "#inner", 
        // language=JavaScript
        `export let $; export const set = a => {$ = a}`);
        innerModule.callMethodIgnored("set", undefined, this.#program.createMaybeAsyncFunctionDeref(this.callApi, { release: true }));
    }
    getPossibleApiModuleName(file) {
        if (file.startsWith(this.#apiPrefix))
            return file.substring(this.#apiPrefix.length);
    }
    createApiSource(apiName, program) {
        const api = this.#apiHelperController?.getOrCreateApi(apiName);
        if (!api)
            return;
        const methods = Object.getOwnPropertyNames(api);
        // language=JavaScript
        const innerModuleCode = `
			import {$} from ${JSON.stringify(this.#apiPrefix + "#inner")};
			const createMethod = (name) => (...args) => $(${JSON.stringify(apiName)}, name, ...args);
			export default Object.freeze({
				${methods.map((methodName) => (
        // language=JavaScript prefix="export default {" suffix="}"
        `[${JSON.stringify(methodName)}]: createMethod(${JSON.stringify(methodName)})`)).join(",")}
			});
		`;
        program.setBuiltinModuleName(this.#apiPrefix + apiName, true);
        return innerModuleCode;
    }
    callApi = (apiName, method, ...args) => {
        const api = this.#apiHelperController?.getApi(String(apiName));
        if (!api)
            throw new Error(`api not initialized: ${apiName}`);
        const methodName = String(method);
        const methods = Object.getOwnPropertyNames(api);
        if (!methods.includes(methodName))
            throw new Error(`api has no method: ${methodName}`);
        return api[methodName]?.(...args);
    };
}
//# sourceMappingURL=ApiModuleHelper.js.map
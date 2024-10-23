import IVM from "isolated-vm";
export class PerformanceModuleHelper {
    #initTime;
    #program;
    #moduleName;
    getNow = () => performance.now() - this.#initTime;
    constructor(program, moduleName) {
        this.#initTime = performance.now();
        this.#program = program;
        this.#moduleName = moduleName;
    }
    async execute() {
        const innerModule = await this.#program.createModule(`${this.#moduleName}#inner`, "export let now; export const $set = s => {now = s};");
        await innerModule.callMethod("$set", undefined, new IVM.Callback(this.getNow));
        await this.#program.createModule(this.#moduleName, `export { now } from "#inner";`);
    }
}
//# sourceMappingURL=PerformanceModuleHelper.js.map
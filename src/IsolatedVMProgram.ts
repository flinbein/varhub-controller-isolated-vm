import IVM, { type Isolate, type Context, type Module } from "isolated-vm";
import * as inspector from "node:inspector";

interface GetSource {
	(filename: string): undefined | string | Promise<string>;
}

export class IsolatedVMProgram {
	readonly #isolate: Isolate;
	readonly #compileModuleHook: (isolate: Isolate, specifier: string, code: string, metaObject?: any) => Module;
	readonly #getOwnPropertyNamesHook: (val: any) => string[];
	readonly #context: Context;
	readonly #getSource: GetSource;
	
	constructor(getSource: GetSource, {memoryLimitMb = 8, inspector = false} = {}) {
		this.#getSource = getSource;
		this.#isolate = new IVM.Isolate({memoryLimit: memoryLimitMb, inspector: inspector});
		this.#context = this.#isolate.createContextSync({inspector: inspector});
		const compileContext = this.#isolate.createContextSync({inspector: false});
		this.#compileModuleHook = compileContext.evalSync(
			// language=javascript
			`(isolate, moduleName, code, metaObject) => isolate.compileModuleSync(code, {
    			filename: moduleName,
                meta: (metaVal) => Object.assign(metaVal, metaObject ?? {})
			});`
		) as (isolate: Isolate, moduleName: string, code: string, metaObject: any) => Module;
		this.#getOwnPropertyNamesHook = compileContext.evalSync(
			// language=javascript
			`(val) => Object.getOwnPropertyNames(val)`
		);
	}
	
	#compileModule(filename: string, code: string, metaObject?: any): Module{
		return this.#compileModuleHook(this.#isolate, filename, code, metaObject);
	}
	
	async createModule(moduleName: string): Promise<IsolateModule> {
		const code = await this.#getSource(moduleName);
		if (code === undefined) throw new Error("module not found: " + moduleName);
		const module = this.#compileModule(moduleName, code, {url: moduleName});
		await module.instantiate(this.#context, this.#resolveModule);
		await module.evaluate();
		return new IsolateModule(module, this.#getOwnPropertyNamesHook);
	}
	
	#resolveModule = (specifier: string, referrer: Module): Module | Promise<Module> => {
		throw new Error("unimplemented resolveModule");
	}
	
	
}

class IsolateModule {
	#module: Module;
	#getOwnPropertyNamesHook: (val: any) => string[];
	constructor(module: Module, getOwnPropertyNamesHook: (val: any) => string[]) {
		this.#module = module;
		this.#getOwnPropertyNamesHook = getOwnPropertyNamesHook
	}
	
	getOwnPropertyNames(){
		return this.#getOwnPropertyNamesHook(this.#module.namespace.derefInto());
	}
	
	getType(prop: string){
		return this.#module.namespace.getSync(prop, {reference: true}).typeof;
	}
	
	async callMethod(prop: string, thisValue:any, ...args: any[]){
		const methodRef = await this.#module.namespace.get(prop, {reference: true});
		return methodRef.apply(thisValue, args, {
			result: {promise: true},
		});
	}
}
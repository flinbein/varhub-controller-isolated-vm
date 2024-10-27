import IVM, {
	Callback,
	type Context,
	type InspectorSession,
	type Isolate,
	type Module,
	type Reference,
	type ReleaseOptions
} from "isolated-vm";
import { clearInterval } from "node:timers";
import { createTimeoutUtils } from "./util/TimeoutUtils.js";
import url from 'node:url';
import { TypedEventEmitter } from "@flinbein/varhub";

interface GetSource {
	(descriptor: string): undefined | {
		name: string,
		getSource(): Source | Promise<Source>
	};
}
interface Source {
	type?: string | null,
	text: string,
}

type IsolatedVMProgramEvents = {
	dispose: []
}

export class IsolatedVMProgram extends TypedEventEmitter<IsolatedVMProgramEvents> implements Disposable {
	readonly #isolate: Isolate;
	readonly #compileModuleHook: (isolate: Isolate, specifier: string, code: string, metaObject?: any) => Promise<Module>;
	readonly #context: Context;
	readonly #safeContext: Context;
	readonly #inspector: boolean;
	readonly #getModuleSource: GetSource;
	readonly #modulePromiseMap = new Map<string, Promise<Module>>();
	readonly #moduleNamesMap = new WeakMap<Module, string>();
	readonly #moduleWrapperMap = new WeakMap<Module, ProgramModule>();
	readonly #wrapMaybeAsyncRef: Reference;
	readonly #getOwnPropertyNamesRef;
	readonly #getPropRef;
	readonly #constructRef;
	readonly #startRpcRef;
	
	constructor(getSource: GetSource, {memoryLimitMb = 8, inspector = false} = {}) {
		super();
		this.#inspector = inspector;
		this.#getModuleSource = getSource;
		this.#isolate = new IVM.Isolate({memoryLimit: memoryLimitMb, inspector: inspector});
		this.#addDisposeHook(
			startIsolateCounter(this.#isolate, this, 10000, 2000000000n)
		);
		const context = this.#context = this.#isolate.createContextSync({inspector: inspector});
		const safeContext = this.#safeContext = this.#isolate.createContextSync({inspector: false});
		this.#addDisposeHook(createTimeoutUtils(context, context));
		
		const compileModuleRef: Reference<(...args: any) => Module> = safeContext.evalSync( /* language=javascript */
			`(isolate, moduleName, code, metaObject) => isolate.compileModuleSync(code, {
    			filename: moduleName,
                meta: (metaVal) => Object.assign(metaVal, metaObject ?? {})
			});`,
			{reference: true}
		);
		this.#compileModuleHook = (isolate: Isolate, moduleName: string, code: string, metaObject: any): Promise<Module> =>  {
			return compileModuleRef.apply(
				undefined,
				[isolate, moduleName, code, metaObject],
				{result: {promise: true}, arguments: {copy: true}}
			);
		}
		
		this.#getOwnPropertyNamesRef = safeContext.evalSync(`Object.getOwnPropertyNames`, {reference: true});
		this.#getPropRef = safeContext.evalSync(`(m,k)=>m[k]`, {reference: true});
		this.#constructRef = safeContext.evalSync(`(c,...a)=>new c(...a)`, {reference: true});
		
		this.#startRpcRef = this.#context.evalSync(/* language=javascript */ `
            (RPCSource, room, module) => {
                const current = new RPCSource(module);
                Object.defineProperty(RPCSource, "current", {get: () => current});
                RPCSource.start(current, room);
			}
		`, {reference: true});
		
		this.#wrapMaybeAsyncRef = this.#safeContext.evalSync( /* language=javascript */ `
            (callFnRef) => (...args) => {
                const ref = callFnRef.applySync(undefined, [...args], {
                    result: {reference: true},
                    arguments: {copy: true}
                });
                const isPromise = ref.getSync("isPromise");
                const isError = ref.getSync("isError");
				let value = ref.getSync("get", {reference: true}).applySync(undefined, [], {
					result: {promise: isPromise, copy: true}
				});
                if (isPromise) {
                    value = value.then(({rejected, value}) => {
                        if (rejected) throw value;
                        return value;
					})
				}
                if (isError) throw value;
                return value;
            
            }
		`, {reference: true});
	}
	
	async getOwnNames(ref: Reference): Promise<string[]> {
		return await this.#getOwnPropertyNamesRef.apply(undefined, [ref.derefInto()], {result: {copy: true}}) as any;
	}
	
	async startRpc(moduleName: string){
		const asRef = {result: {reference: true}, reference: true} as const;
		const sourceModule = await this.#getIsolatedModule(moduleName);
		const rpcModule = await this.#getIsolatedModule("varhub:rpc");
		const roomModule = await this.#getIsolatedModule("varhub:room");
		const rpcConstructorRef = await rpcModule.namespace.get("default", asRef);
		const roomRef = await roomModule.namespace.get("default", asRef);
		await this.#startRpcRef.apply(
			undefined,
			[rpcConstructorRef.derefInto({release: true}), roomRef.derefInto({release: true}), sourceModule.namespace.derefInto()],
			asRef
		);
	}
	
	createMaybeAsyncFunctionDeref(fn: (...args: any) => any, opts?: ReleaseOptions){
		const callFn = (...args: any[]) => {
			let value: any, isError = false;
			try {
				value = fn(...args);
			} catch (error) {
				value = error;
				isError = true;
			}
			const isPromise = value instanceof Promise;
			if (isPromise) {
				return {
					isPromise,
					isError,
					get: () => {
						return value.then(
							(value: any) => ({rejected: false, value}),
							(value: any) => ({rejected: true, value})
						);
					}
				}
			}
			return {isPromise, isError, get: () => value}
		}
		
		return this.#wrapMaybeAsyncRef.applySync(undefined, [callFn], {
			arguments: {reference: true},
			result: {reference: true}
		}).derefInto(opts);
	}
	
	createInspectorSession(): IsolatedVMProgramInspector {
		if (!this.#inspector) throw new Error("inspector is disabled");
		const inspector = this.#isolate.createInspectorSession();
		const programInspector = new IsolatedVMProgramInspector(inspector);
		const onDispose = () => programInspector.dispose();
		this.#addDisposeHook(onDispose);
		programInspector.on("dispose", () => this.#deleteDisposeHook(onDispose));
		return programInspector;
	}
	
	readonly #builtinModuleNames = new Set<string>;
	setBuiltinModuleName(moduleName: string, builtin: boolean): void {
		if (builtin) {
			this.#builtinModuleNames.add(moduleName);
		} else {
			this.#builtinModuleNames.delete(moduleName);
		}
	}
	
	async getModule(moduleName: string): Promise<ProgramModule> {
		const module = await this.#getIsolatedModule(moduleName, "");
		const foundModuleWrapper = this.#moduleWrapperMap.get(module);
		if (foundModuleWrapper) return foundModuleWrapper;
		const moduleWrapper = new ProgramModule(module, this);
		this.#moduleWrapperMap.set(module, moduleWrapper);
		return moduleWrapper;
	}
	
	async createModule(moduleName: string, code: string, type?: string): Promise<ProgramModule> {
		void this.#createIsolatedModule(moduleName, code, type);
		return this.getModule(moduleName);
	}
	
	async #createIsolatedModule(moduleName: string, src: string, type?: string|null, additionalNames: string[] = []): Promise<Module> {
		if (this.#modulePromiseMap.has(moduleName)) throw new Error(`Module ${moduleName} already exists`);
		const modulePromise = (async () => {
			const isJson = type?.toLowerCase().includes("json");
			if (isJson) src = `export default ${src}`;
			
			const meta = {url: moduleName};
			const module = await this.#compileModuleHook(this.#isolate, moduleName, src, meta);
			this.#moduleNamesMap.set(module, moduleName);
			await module.instantiate(this.#context, this.#resolveModule);
			await module.evaluate({reference: true, promise: true});
			return module;
		})();
		this.#modulePromiseMap.set(moduleName, modulePromise);
		for (let additionalName of additionalNames) this.#modulePromiseMap.set(additionalName, modulePromise);
		return modulePromise;
	}
	
	async #getIsolatedModule(moduleDescriptor: string, from?: string): Promise<Module> {
		const foundModulePromise = this.#modulePromiseMap.get(moduleDescriptor);
		if (foundModulePromise) return foundModulePromise;
		const moduleSource = this.#getModuleSource(moduleDescriptor);
		if (!moduleSource) throw new Error("module not found: "+ moduleDescriptor + (from ? " in: "+from : ""));
		const foundModulePromiseByName = this.#modulePromiseMap.get(moduleSource.name);
		if (foundModulePromiseByName) return foundModulePromiseByName;
		const {type, text} = await moduleSource.getSource();
		return this.#createIsolatedModule(moduleSource.name, text, type, [moduleDescriptor]);
	}
	
	#resolveModule = async (specifier: string, referrer: Module): Promise<Module> => {
		const referrerName = this.#moduleNamesMap.get(referrer);
		if (referrerName == null) throw new Error("imported from unknown module");
		let modulePath: string;
		if (specifier.startsWith('#')) {
			modulePath = referrerName + specifier;
		} else if (specifier.includes("#") && !this.#builtinModuleNames.has(referrerName)) {
			throw new Error(`private module: ${specifier} in: ${referrerName}`);
		} else {
			modulePath = url.resolve(referrerName, specifier);
		}
		return await this.#getIsolatedModule(modulePath, referrerName);
	}
	
	#disposeHooks = new Set<() => void>();
	#addDisposeHook(hook: () => void) {
		this.#disposeHooks.add(hook);
	}
	#deleteDisposeHook(hook: () => void) {
		this.#disposeHooks.delete(hook);
	}
	
	dispose(){
		this[Symbol.dispose]();
	}
	
	#isDisposed = false;
	
	get isDisposed(){
		return this.#isDisposed;
	}
	
	[Symbol.dispose](): void {
		if (this.#isDisposed) return;
		for (let disposeHook of this.#disposeHooks) try {
			disposeHook();
		} catch {}
		try {
			this.#isolate.dispose()
		} catch {}
		this.#isDisposed = true;
		this.emit("dispose");
	}
}

export class ProgramModule {
	#module: Module;
	#program: IsolatedVMProgram;
	constructor(module: Module, program: IsolatedVMProgram) {
		this.#module = module;
		this.#program = program;
	}
	
	getDependencySpecifiers(): string[] {
		return this.#module.dependencySpecifiers
	}
	
	getType(prop: string){
		return this.#module.namespace.getSync(prop, {reference: true})?.typeof;
	}
	
	getKeysAsync(): Promise<string[]> {
		return this.#program.getOwnNames(this.#module.namespace);
	}
	
	async callMethod(prop: string, thisValue?: any, ...args: any[]){
		const methodRef = await this.#module.namespace.get(prop, {reference: true});
		return methodRef.apply(thisValue ? new IVM.ExternalCopy(thisValue).copyInto() : thisValue, args, {
			result: {promise: true, copy: true}, arguments: {copy: true}
		});
	}
	
	callMethodIgnored(prop: string, thisValue?: any, ...args: any[]): void {
		this.#module.namespace.get(prop, {reference: true}).then(methodRef => {
			methodRef.applyIgnored(thisValue, args, {arguments: {copy: true}});
		});
	}
	
	async getProp(prop: string): Promise<any> {
		return this.#module.namespace.get(prop, {copy: true});
	}
}

function startIsolateCounter(isolate: Isolate, program: IsolatedVMProgram, checkoutMs: number, maxValue: bigint){
	const isolateWeakRef = new WeakRef(isolate);
	let lastWallTime = 0n;
	const intervalId = setInterval(() => {
		const derefIsolate = isolateWeakRef.deref();
		if (!derefIsolate || derefIsolate.isDisposed) {
			program.dispose();
			return clearInterval(intervalId);
		}
		const wallTime = derefIsolate.wallTime;
		const wallTimeDiff = wallTime - lastWallTime;
		lastWallTime = wallTime;
		if (wallTimeDiff > maxValue) {
			program.dispose();
			clearInterval(intervalId);
		}
	}, checkoutMs);
	return () => {
		clearInterval(intervalId);
	}
}

export type IsolatedVMInspectorEvents = {
	response: [number, string];
	notification: [string];
	dispose: [];
}
export class IsolatedVMProgramInspector extends TypedEventEmitter<IsolatedVMInspectorEvents> implements Disposable {
	#session: InspectorSession
	constructor(session: InspectorSession) {
		super();
		this.#session = session;
		session.onResponse = (callId, message) => {this.emit("response", callId, message)}
		session.onNotification = (message) => {this.emit("notification", message)}
		
	}
	
	dispatchProtocolMessage(message: string) {
		const msg = JSON.parse(String(message));
		if (msg.method === "Runtime.compileScript") {
			this.emit("response", msg.id, JSON.stringify({id: msg.id, result: {fake: true}}))
			return;
		}
		if (msg.method === "Runtime.evaluate" && msg.params) {
			delete msg.params.replMode;
			delete msg.params.awaitPromise;
		}
		this.#session.dispatchProtocolMessage(JSON.stringify(msg));
	}
	
	dispose(){
		this[Symbol.dispose]();
	}
	
	#isDisposed = false;
	get isDisposed() {
		return this.#isDisposed;
	}
	[Symbol.dispose](){
		if (this.#isDisposed) return;
		this.#isDisposed = true;
		this.#session.dispose();
		this.emit("dispose");
	}
}
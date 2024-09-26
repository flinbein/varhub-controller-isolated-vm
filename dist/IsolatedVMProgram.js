import IVM from "isolated-vm";
import { clearInterval } from "node:timers";
import { createTimeoutUtils } from "./util/TimeoutUtils.js";
import url from 'node:url';
import { TypedEventEmitter } from "@flinbein/varhub";
export class IsolatedVMProgram extends TypedEventEmitter {
    #isolate;
    #compileModuleHook;
    #context;
    #safeContext;
    #inspector;
    #getModuleSource;
    #modulePromiseMap = new Map();
    #moduleNamesMap = new WeakMap();
    #moduleWrapperMap = new WeakMap();
    #wrapMaybeAsyncRef;
    constructor(getSource, { memoryLimitMb = 8, inspector = false } = {}) {
        super();
        this.#inspector = inspector;
        this.#getModuleSource = getSource;
        this.#isolate = new IVM.Isolate({ memoryLimit: memoryLimitMb, inspector: inspector });
        this.#addDisposeHook(() => this.#isolate.dispose());
        this.#addDisposeHook(startIsolateCounter(this.#isolate, this, 1000, 200000000n));
        const context = this.#context = this.#isolate.createContextSync({ inspector: inspector });
        this.#addDisposeHook(createTimeoutUtils(context));
        const safeContext = this.#safeContext = this.#isolate.createContextSync({ inspector: false });
        const compileModuleRef = safeContext.evalSync(/* language=javascript */ `(isolate, moduleName, code, metaObject) => isolate.compileModuleSync(code, {
    			filename: moduleName,
                meta: (metaVal) => Object.assign(metaVal, metaObject ?? {})
			});`, { reference: true });
        this.#compileModuleHook = (isolate, moduleName, code, metaObject) => {
            return compileModuleRef.apply(undefined, [isolate, moduleName, code, metaObject], { result: { promise: true }, arguments: { copy: true } });
        };
        this.#wrapMaybeAsyncRef = this.#safeContext.evalSync(/* language=javascript */ `
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
		`, { reference: true });
    }
    createMaybeAsyncFunctionDeref(fn, opts) {
        const callFn = (...args) => {
            let value, isError = false;
            try {
                value = fn(...args);
            }
            catch (error) {
                value = error;
                isError = true;
            }
            const isPromise = value instanceof Promise;
            if (isPromise) {
                return {
                    isPromise,
                    isError,
                    get: () => {
                        return value.then((value) => ({ rejected: false, value }), (value) => ({ rejected: true, value }));
                    }
                };
            }
            return { isPromise, isError, get: () => value };
        };
        return this.#wrapMaybeAsyncRef.applySync(undefined, [callFn], {
            arguments: { reference: true },
            result: { reference: true }
        }).derefInto(opts);
    }
    createInspectorSession() {
        if (!this.#inspector)
            throw new Error("inspector is disabled");
        const inspector = this.#isolate.createInspectorSession();
        return new IsolatedVMProgramInspector(inspector);
    }
    #builtinModuleNames = new Set;
    setBuiltinModuleName(moduleName, builtin) {
        if (builtin) {
            this.#builtinModuleNames.add(moduleName);
        }
        else {
            this.#builtinModuleNames.delete(moduleName);
        }
    }
    async getModule(moduleName) {
        const module = await this.#getIsolatedModule(moduleName, "");
        const foundModuleWrapper = this.#moduleWrapperMap.get(module);
        if (foundModuleWrapper)
            return foundModuleWrapper;
        const moduleWrapper = new ProgramModule(module);
        this.#moduleWrapperMap.set(module, moduleWrapper);
        return moduleWrapper;
    }
    async createModule(moduleName, code, type) {
        void this.#createIsolatedModule(moduleName, code, type);
        return this.getModule(moduleName);
    }
    async #createIsolatedModule(moduleName, src, type, additionalNames = []) {
        if (this.#modulePromiseMap.has(moduleName))
            throw new Error(`Module ${moduleName} already exists`);
        const modulePromise = (async () => {
            const isJson = type?.toLowerCase().includes("json");
            if (isJson)
                src = `export default ${src}`;
            const meta = { url: moduleName };
            const module = await this.#compileModuleHook(this.#isolate, moduleName, src, meta);
            this.#moduleNamesMap.set(module, moduleName);
            await module.instantiate(this.#context, this.#resolveModule);
            await module.evaluate({ reference: true, promise: true });
            return module;
        })();
        this.#modulePromiseMap.set(moduleName, modulePromise);
        for (let additionalName of additionalNames)
            this.#modulePromiseMap.set(additionalName, modulePromise);
        return modulePromise;
    }
    async #getIsolatedModule(moduleDescriptor, from) {
        const foundModulePromise = this.#modulePromiseMap.get(moduleDescriptor);
        if (foundModulePromise)
            return foundModulePromise;
        const moduleSource = this.#getModuleSource(moduleDescriptor);
        if (!moduleSource)
            throw new Error("module not found: " + moduleDescriptor + (from ? " in: " + from : ""));
        const foundModulePromiseByName = this.#modulePromiseMap.get(moduleSource.name);
        if (foundModulePromiseByName)
            return foundModulePromiseByName;
        const { type, text } = await moduleSource.getSource();
        return this.#createIsolatedModule(moduleSource.name, text, type, [moduleDescriptor]);
    }
    #resolveModule = async (specifier, referrer) => {
        const referrerName = this.#moduleNamesMap.get(referrer);
        if (referrerName == null)
            throw new Error("imported from unknown module");
        let modulePath;
        if (specifier.startsWith('#')) {
            modulePath = referrerName + specifier;
        }
        else if (specifier.includes("#") && !this.#builtinModuleNames.has(referrerName)) {
            throw new Error(`private module: ${specifier} in: ${referrerName}`);
        }
        else {
            modulePath = url.resolve(referrerName, specifier);
        }
        return await this.#getIsolatedModule(modulePath, referrerName);
    };
    #disposeHooks = new Set();
    #addDisposeHook(hook) {
        this.#disposeHooks.add(hook);
    }
    dispose() {
        this[Symbol.dispose]();
    }
    #isDisposed = false;
    get isDisposed() {
        return this.#isDisposed;
    }
    [Symbol.dispose]() {
        for (let disposeHook of this.#disposeHooks)
            try {
                disposeHook();
            }
            catch { }
        this.#isDisposed = true;
        this.emit("dispose");
    }
}
export class ProgramModule {
    #module;
    constructor(module) {
        this.#module = module;
    }
    getType(prop) {
        return this.#module.namespace.getSync(prop, { reference: true })?.typeof;
    }
    async callMethod(prop, thisValue, ...args) {
        const methodRef = await this.#module.namespace.get(prop, { reference: true });
        return methodRef.apply(thisValue ? new IVM.ExternalCopy(thisValue).copyInto() : thisValue, args, {
            result: { promise: true, copy: true }, arguments: { copy: true }
        });
    }
    callMethodIgnored(prop, thisValue, ...args) {
        this.#module.namespace.get(prop, { reference: true }).then(methodRef => {
            methodRef.applyIgnored(thisValue, args, { arguments: { copy: true } });
        });
    }
    async getProp(prop) {
        return this.#module.namespace.get(prop, { copy: true });
    }
}
function startIsolateCounter(isolate, program, checkoutMs, maxValue) {
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
    };
}
export class IsolatedVMProgramInspector extends TypedEventEmitter {
    #session;
    constructor(session) {
        super();
        this.#session = session;
        session.onResponse = (callId, message) => { this.emit("response", callId, message); };
        session.onNotification = (message) => { this.emit("notification", message); };
    }
    dispatchProtocolMessage(message) {
        const msg = JSON.parse(String(message));
        if (msg.method === "Runtime.compileScript") {
            this.emit("response", msg.id, JSON.stringify({ id: msg.id, result: { fake: true } }));
            return;
        }
        if (msg.method === "Runtime.evaluate" && msg.params) {
            delete msg.params.replMode;
            delete msg.params.awaitPromise;
        }
        this.#session.dispatchProtocolMessage(JSON.stringify(msg));
    }
    dispose() {
        this[Symbol.dispose]();
    }
    [Symbol.dispose]() {
        this.#session.dispose();
    }
}
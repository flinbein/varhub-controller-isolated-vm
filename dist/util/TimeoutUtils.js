import IVM from "isolated-vm";
import { clearInterval, clearTimeout } from "node:timers";
export function createTimeoutUtils(context, evalContext) {
    const timeoutMap = new Map();
    const intervalMap = new Map();
    const immediateMap = new Map();
    let timeoutId = 1, intervalId = 1, immediateId = 1;
    // language=javascript
    const createTimersRef = evalContext.evalSync(`
		const timeoutHooks = new Map();
		const intervalHooks = new Map();
		const immediateHooks = new Map();
        (hooks, global) => {
            Object.defineProperties(global, {
                setTimeout: {
                    value: (cb, t=0, ...args) => {
                        if (typeof cb !== "function") throw new Error("callback must be a function");
                        const id = hooks.registerTimeout(t);
                        timeoutHooks.set(id, () => cb(...args));
                        return id;
                    }
                },
                clearTimeout: {
                    value: (id) => {
                        timeoutHooks.delete(id);
                        hooks.unregisterTimeout(id);
                    }
                },
                setInterval: {
                    value: (cb, t=0, ...args) => {
                        if (typeof cb !== "function") throw new Error("callback must be a function");
                        const id = hooks.registerInterval(t);
                        intervalHooks.set(id, () => cb(...args));
                        return id;
                    }
                },
                clearInterval: {
                    value: (id) => {
                        intervalHooks.delete(id);
                        hooks.unregisterInterval(id);
                    }
                },
                setImmediate: {
                    value: (cb, ...args) => {
                        if (typeof cb !== "function") throw new Error("callback must be a function");
                        const id = hooks.registerImmediate();
                        immediateHooks.set(id, () => cb(...args));
                        return id;
                    }
                },
                clearImmediate: {
                    value: (id) => {
                        immediateHooks.delete(id);
                        hooks.unregisterImmediate(id);
                    }
                }
			});
            return {
                notifyTimeout: (id) => {
                    timeoutHooks.get(id)?.();
                    timeoutHooks.delete(id);
                },
                notifyInterval: (id) => {
                    intervalHooks.get(id)?.();
                },
				notifyImmediate: (id) => {
                    immediateHooks.get(id)?.();
                    immediateHooks.delete(id);
				}
			}
        }
	`, { reference: true });
    const hooks = {
        registerTimeout: new IVM.Callback((t) => {
            const id = timeoutId++;
            const timeout = setTimeout(async () => {
                const notifyTimeoutRef = await timersRef.get("notifyTimeout", { reference: true });
                notifyTimeoutRef.applyIgnored(undefined, [+id]);
                timeoutMap.delete(id);
            }, +t);
            timeoutMap.set(id, timeout);
            return id;
        }),
        unregisterTimeout: new IVM.Callback((id) => {
            const timeout = timeoutMap.get(+id);
            if (timeout)
                clearTimeout(timeout);
        }, { ignored: true }),
        registerInterval: new IVM.Callback((t) => {
            const id = intervalId++;
            const interval = setInterval(async () => {
                const notifyIntervalRef = await timersRef.get("notifyInterval", { reference: true });
                notifyIntervalRef.applyIgnored(undefined, [+id]);
            }, +t);
            intervalMap.set(id, interval);
            return id;
        }),
        unregisterInterval: new IVM.Callback((id) => {
            const timeout = intervalMap.get(+id);
            if (timeout)
                clearInterval(timeout);
        }, { ignored: true }),
        registerImmediate: new IVM.Callback(() => {
            const id = immediateId++;
            const immediate = setImmediate(async () => {
                const notifyImmediateRef = await timersRef.get("notifyImmediate", { reference: true });
                notifyImmediateRef.applyIgnored(undefined, [+id]);
                immediateMap.delete(id);
            });
            immediateMap.set(id, immediate);
            return id;
        }),
        unregisterImmediate: new IVM.Callback((id) => {
            const immediate = immediateMap.get(+id);
            if (immediate)
                clearImmediate(immediate);
        }, { ignored: true }),
    };
    const timersRef = createTimersRef.applySync(undefined, [hooks, context.global.derefInto()], { result: { reference: true }, arguments: { copy: true } });
    createTimersRef.release();
    return () => {
        timersRef.release();
        [...timeoutMap.values()].forEach(clearTimeout);
        [...intervalMap.values()].forEach(clearInterval);
        [...immediateMap.values()].forEach(clearImmediate);
    };
}
//# sourceMappingURL=TimeoutUtils.js.map
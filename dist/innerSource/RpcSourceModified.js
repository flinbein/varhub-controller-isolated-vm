import rpcSourceCode from "./RPCSource.js";
export const rpcSourceModified = /*language=JavaScript*/ `
import defaultShape from "#inner";
${rpcSourceCode};

const defaultRPCSource = new RPCSource(RPCSource.createDefaultHandler(defaultShape));
Object.defineProperty(RPCSource, "default", {
    get: () => defaultRPCSource
})`;
export const rpcSourceInner = /*language=JavaScript*/ `export default {form: null};`;
//# sourceMappingURL=RpcSourceModified.js.map
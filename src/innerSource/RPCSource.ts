export default /* language=javascript */ `
import { EventEmitter } from "varhub:events";
const isConstructable = (fn) => {
	try {return Boolean(class E extends fn {})} catch {return false}
};
const isESClass = (fn) => (
	typeof fn === 'function'
	&& isConstructable(fn)
	&& Function.prototype.toString.call(fn).startsWith("class")
);
export default class RPCSource {
	static rnd = Math.random();
	#handler;
	#events = new EventEmitter();
	#state;
	constructor(handler, initialState) {
		this.#state = initialState;
		if (typeof handler === "object") {
			const form = handler;
			handler = function (con, path, args, creatingNewChannel) {
				let target = form;
				for (let step of path) {
					if (typeof target !== "object") throw new Error("wrong path");
					if (!Object.keys(target).includes(step)) throw new Error("wrong path");
					target = target[step];
				}
				if (creatingNewChannel && isESClass(target)) {
					const MetaConstructor = function(){return con}
					MetaConstructor.prototype = target.prototype;
					MetaConstructor.connection = con;
					return Reflect.construct(target, args, MetaConstructor);
				}
				return target.apply(con, args);
			};
		}
		this.#handler = handler;
	}
	get state(){return this.#state}
	withEventTypes() {return this}
	setState(state) {
		const newState = typeof state === "function" ? state(this.#state) : state;
		const stateChanged = this.#state !== newState;
		this.#state = newState;
		if (stateChanged) this.#events.emit("state", newState);
		return this;
	}
	withState(state) {
		this.#state = state;
		return this;
	}
	#disposed = false;
	get disposed() {
		return this.#disposed;
	}
	emit(event, ...args) {
		if (this.#disposed) throw new Error("disposed");
		this.#events.emit("message", [event, args]);
		return this;
	}
	dispose(reason) {
		this.#disposed = true;
		this.#events.emit("dispose", [reason]);
	}
	[Symbol.dispose]() {
		this.dispose("disposed");
	}
	static start(rpcSource, room, baseKey, options = { maxChannelsPerClient: Infinity }) {
		const channels = new WeakMap;
		const onConnectionMessage = async (con, ...args) => {
			if (args.length < 4) return;
			const [incomingKey, channelId, operationId, ...msgArgs] = args;
			if (incomingKey !== baseKey) return;
			const source = channelId === undefined ? rpcSource : channels.get(con)?.get(channelId)?.source;
			if (!source) {
				con.send(incomingKey, channelId, 1 /* REMOTE_ACTION.CLOSE */, new Error("wrong channel"));
				if (operationId === 2 /* CLIENT_ACTION.CREATE */) {
					con.send(incomingKey, msgArgs[0], 1 /* REMOTE_ACTION.CLOSE */, new Error("wrong channel"));
				}
				return;
			}
			if (operationId === 0 /* CLIENT_ACTION.CALL */) {
				const [callId, path, callArgs] = msgArgs;
				try {
					try {
						const result = await source.#handler(con, path, callArgs, false);
						if (result instanceof RPCSource) throw new Error("wrong data type");
						con.send(incomingKey, channelId, 0 /* REMOTE_ACTION.RESPONSE_OK */, callId, result);
					}
					catch (error) {
						con.send(incomingKey, channelId, 3 /* REMOTE_ACTION.RESPONSE_ERROR */, callId, error);
					}
				} catch {
					con.send(incomingKey, channelId, 3 /* REMOTE_ACTION.RESPONSE_ERROR */, callId, "parse error");
				}
				return;
			}
			if (operationId === 1 /* CLIENT_ACTION.CLOSE */) {
				const subscriber = channels.get(con)?.get(channelId);
				subscriber?.dispose();
				channels.get(con)?.delete(channelId);
				return;
			}
			if (operationId === 2 /* CLIENT_ACTION.CREATE */) {
				const [newChannelId, path, callArgs] = msgArgs;
				try {
					try {
						let map = channels.get(con);
						if (!map) channels.set(con, map = new Map());
						if (map.size >= options.maxChannelsPerClient) throw new Error("channels limit");
						const result = await source.#handler(con, path, callArgs, true);
						if (!(result instanceof RPCSource)) throw new Error("wrong data type: "+result?.__meta);
						if (result.disposed) throw new Error("channel is disposed");
						const onSourceDispose = (disposeReason) => {
							con.send(incomingKey, newChannelId, 1 /* REMOTE_ACTION.CLOSE */, disposeReason);
							channels.get(con)?.delete(newChannelId);
						};
						const onSourceMessage = (path, args) => {
							if (!Array.isArray(path)) path = [path];
							con.send(incomingKey, newChannelId, 4 /* REMOTE_ACTION.EVENT */, path, args);
						};
						const onSourceState = (state) => {
							con.send(incomingKey, newChannelId, 2 /* REMOTE_ACTION.CREATE */, state);
						};
						const dispose = () => {
							result.#events.off("dispose", onSourceDispose);
							result.#events.off("message", onSourceMessage);
							result.#events.off("state", onSourceState);
						};
						con.send(incomingKey, newChannelId, 2 /* REMOTE_ACTION.CREATE */, result.state);
						map.set(newChannelId, { dispose, source: result });
						result.#events.once("dispose", onSourceDispose);
						result.#events.on("message", onSourceMessage);
						result.#events.on("state", onSourceState);
					}
					catch (error) {
						con.send(incomingKey, newChannelId, 1 /* REMOTE_ACTION.CLOSE */, error);
					}
				} catch {
					con.send(incomingKey, newChannelId, 1 /* REMOTE_ACTION.CLOSE */, "parse error");
				}
			}
		};
		const clearChannelsForConnection = (con) => {
			for (let value of channels.get(con)?.values() ?? []) {
				value.dispose();
			}
		};
		room.on("connectionClose", clearChannelsForConnection);
		room.on("connectionMessage", onConnectionMessage);
		return function dispose() {
			room.off("connectionMessage", onConnectionMessage);
			room.off("connectionClose", clearChannelsForConnection);
			for (let connection of room.getConnections()) {
				clearChannelsForConnection(connection);
			}
		};
	}
}`
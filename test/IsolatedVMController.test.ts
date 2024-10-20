import * as assert from "node:assert";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { ControllerCode, IsolatedVMController } from "../src/IsolatedVMController.js";
import { Room, ApiSource, ApiHelper, ApiHelperController, Connection, RPCController } from "@flinbein/varhub";

class Counter implements ApiHelper {
	_value = 0;
	next = () => ++this._value;
	current = () => this._value;
	error = () => { throw this._value }
	[Symbol.dispose](){}
}

class Network implements ApiHelper {
	fetch = async (url: unknown) => {
		await new Promise(r => setTimeout(r, 100))
		return {status: 200, data: `fetched:`+url}
	}
	fetchWithError = async (url: unknown) => {
		await new Promise(r => setTimeout(r, 100))
		throw {status: 400, data: `fetched:`+url}
	}
	[Symbol.dispose](){}
}

const apiSource: ApiSource = {Counter, Network}

class Client {
	private _connection: Connection | undefined
	private readonly _room: Room;
	private readonly _params: any[];
	private readonly _eventLog: unknown[] = [];
	private _nextRpcId = 0;
	private _rpcResultEmitter = new EventEmitter();
	private _rpcEventEmitter = new EventEmitter();
	private _closeReason: string | null | undefined = undefined;
	private _resolvers = (Promise as any).withResolvers();
	constructor(room: Room, ...params: any[]) {
		this._room = room;
		this._params = params;
		this._resolvers.promise.catch(() => {});
	}
	
	enter(): this {
		this._connection = this._room.createConnection()
			.on("disconnect", (ignored, reason) => {
				this._resolvers.reject(reason);
				this._closeReason = reason;
				for (let eventName of this._rpcResultEmitter.eventNames()) {
					this._rpcResultEmitter.emit(eventName, 3);
				}
			})
			.on("join", () => {
				this._resolvers.resolve();
			})
			.on("event", (...eventArgs) => {
				const [eventId, channelId, operationId, ...args] = eventArgs;
				if (eventId !== "$rpc" || channelId !== undefined) return;
				if (operationId === 0 || operationId === 3) {
					const [callId, callResult] = args;
					this._rpcResultEmitter.emit(callId, operationId, callResult);
				}
				if (operationId === 4) {
					const [path, values] = args;
					this._rpcEventEmitter.emit(path[0], ...values);
					this._eventLog.push(args);
				}
			})
			.enter(...this._params)
		;
		return this;
	}
	
	then<R1 = [this], R2 = never>(
		onfulfilled?: ((value: [this]) => R1 | PromiseLike<R1>) | undefined | null,
		onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | undefined | null
	): PromiseLike<R1 | R2> {
		return this._resolvers.promise.then(() => [this] as [this]).then(onfulfilled, onrejected);
	};
	
	open(){
		this._room!.join(this._connection!);
		return this;
	}

	get eventLog(){
		return this._eventLog;
	}

	get closeReason(){
		return this._closeReason;
	}

	get params(){
		return this._params;
	}
	
	call(methodName: string, ...args: any[]): unknown {
		if (this.status !== "joined") throw new Error("client not joined");
		const rpcId = this._nextRpcId++;
		let code: [unknown, unknown] | undefined = undefined
		let resolver: [(arg: unknown) => void, (arg: unknown) => void] | undefined = undefined;
		this._rpcResultEmitter.once(rpcId as any, (errorCode, result) => {
			code = [errorCode, result];
			if (!resolver) return;
			if (errorCode) resolver[1](result);
			resolver[0](result);
		})
		this._connection!.message("$rpc", undefined, 0, rpcId, [methodName], args);
		if (code) {
			if (code[0]) throw code[1];
			return code[1];
		}
		return new Promise((success, fail) => {
			resolver = [success, fail];
		})
	}
	
	sendRaw(...args: any[]){
		this._connection!.message(...args);
	}
	
	onRawEvent(handler: (...args: any[]) => void) {
		this._connection!.on("event", handler);
		return () => void this._connection!.off("event", handler);
	}
	
	
	get status(){
		return this._connection!.status
	}

	leave(reason?: string | null){
		return this._connection!.leave(reason);
	}

	on(eventName: string, handler: (...args: unknown[]) => void): this{
		this._rpcEventEmitter.on(eventName, handler);
		return this;
	}
}

describe("test controller",() => {

	it("simple ctrl methods", {timeout: 500}, async () => {
		const code = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					room.on("connection", con => con.open());

					export function greet(){
    					return "Hello, " + this.parameters[0] + "!";
					}

                    export function getPlayers(){
                        return [...room.getConnections()].map(c => c.parameters[0]);
					}
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const [bobClient] = await new Client(room, "Bob").enter();
		const greetMessage = await bobClient.call("greet");
		assert.equal(greetMessage, "Hello, Bob!", "greet message for Bob");

		const [bobClient2] = await new Client(room, "Bob").enter();
		const greetMessage2 = await bobClient2.call("greet");
		assert.equal(greetMessage2, "Hello, Bob!", "greet message 2 for Bob");

		const [aliceClient] = await new Client(room, "Alice").enter();
		const greetMessage3 = await aliceClient.call("greet");
		assert.equal(greetMessage3, "Hello, Alice!", "greet message for Alice");

		const players = await aliceClient.call("getPlayers") as any[];
		assert.deepEqual(new Set(players), new Set(["Bob", "Alice"]), "get all players");
	});

	it("async ctrl methods", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    export async function greet(){
                        await new Promise(r => setTimeout(r, 1));
                        return "Hello, " + this.parameters[0] + "!";
                    }
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const [bobClient] = await new Client(room, "Bob").enter();
		const greetResult = await bobClient.call("greet");
		assert.equal(greetResult, "Hello, Bob!", "greet bob");
	});

	it("api methods", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import counter from "varhub:api/Counter";
                    export const getCurrent = () => counter.current()
                    export const getNext = () => counter.next()
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const [client] = await new Client(room, "Bob").enter();
		assert.equal(await client.call("getCurrent"), 0, "current = 0");
		assert.equal(await client.call("getNext"), 1, "next = 0");
		assert.equal(await client.call("getCurrent"), 1, "current = 1");
	});

	it("api error methods", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import counter from "varhub:api/Counter";
                    export const getError = () => counter.error();
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const [client] = await new Client(room, "Bob").enter();
		await assert.rejects(
			async () => client.call("getError"),
			(error: any) => error === 0,
			"error = 0"
		);
	});

	it("async api methods", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import network from "varhub:api/Network";
                    export const fetch = async (url) => {
                        const response = await network.fetch(url);
                        return response.data;
                    }
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const [client] = await new Client(room, "Bob").enter();
		assert.equal(
			await client.call("fetch", "https://google.com"),
			"fetched:https://google.com",
			"fetched url"
		);
	});

	it("async api error methods", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import network from "varhub:api/Network";
                    export const fetchWithError = async (url) => {
                        try {
                            await network.fetchWithError(url);
                        } catch (error) {
                            return error.status
						}
                    }
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const [client] = await new Client(room, "Bob").enter();
		assert.equal(await client.call("fetchWithError", "https://google.com"), 400, "fetched url error");
	});

	it("room message", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
                    room.on("connection", con => con.open());
                    export const getRoomMessage = () => room.message
                    export const setRoomMessage = (msg) => room.message = msg;
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const [client] = await new Client(room, "Bob").enter();
		assert.equal(await client.call("getRoomMessage"), null, "default message is null");
		await client.call("setRoomMessage", "test");
		assert.equal(room.publicMessage, "test", "message is test");
		assert.equal(await client.call("getRoomMessage"), "test", "next message is test");
	});

	it("room closed", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
					let closed = false;
                    room.on("connection", con => {
                        closed ? con.close("room-closed") : con.open();
                    });
                    export const getRoomClosed = () => closed
                    export const setRoomClosed = (msg) => closed = msg;
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const [bobClient] = await new Client(room, "Bob").enter();
		assert.equal(await bobClient.call("getRoomClosed"), false, "default closed is false");

		const [eveClient] = await new Client(room, "Eve").enter();
		assert.equal(eveClient.status, "joined", "Eve joined");

		await bobClient.call("setRoomClosed", true);
		assert.equal(await bobClient.call("getRoomClosed"), true, "next closed is true");

		const aliceClient = new Client(room, "Alice").enter();
		await assert.rejects(Promise.resolve(aliceClient), "alice can not join");
		await new Promise(r => setTimeout(r, 10)); // wait for close
	});

	it("room destroy", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
                    room.on("connection", con => con.open());
                    export const destroy = () => room.destroy();
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const [bobClient] = await new Client(room, "Bob").enter();
		assert.equal(room.destroyed, false, "room not destroyed");
		await Promise.allSettled([bobClient.call("destroy")]);
		assert.equal(room.destroyed, true, "room destroyed");
	});

	it("room player status, kick", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
                    import Players from "varhub:players";

                    const players = new Players(room, (_c, name) => name);

                    export function isPlayerOnline(name){
                        return players.get(name)?.online;
					}
                    export function hasPlayer(name){
                     	return players.get(name)?.registered ?? false
					}
                    export function kick(name){
                        players.get(name).kick();
					};
				`
			}
		}

		using room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const [bobClient] = await new Client(room, "Bob").enter();
		assert.equal(await bobClient.call("isPlayerOnline", "Alice"), undefined, "Alice online is undefined");
		assert.equal(await bobClient.call("hasPlayer", "Alice"), false, "no player Alice");

		const [aliceClient] = await new Client(room, "Alice").enter();

		assert.equal(await bobClient.call("isPlayerOnline", "Alice"), true, "Alice online is true");
		assert.equal(await bobClient.call("hasPlayer", "Alice"), true, "has player Alice");

		aliceClient.leave();

		assert.equal(await bobClient.call("isPlayerOnline", "Alice"), false, "Alice online is false after leave");
		assert.equal(await bobClient.call("hasPlayer", "Alice"), true, "has player Alice after leave");

		await bobClient.call("kick", "Alice");

		assert.equal(await bobClient.call("isPlayerOnline", "Alice"), undefined, "Alice online is undefined after kick");
		assert.equal(await bobClient.call("hasPlayer", "Alice"), false, "no player Alice after kick");

		await Promise.allSettled([bobClient.call("kick", "Bob")]);
		assert.equal(bobClient.status, "disconnected", "Bob kick himself");
		await new Promise(resolve => setTimeout(resolve, 10)); // wait because error
	});

	it("room send, broadcast", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
                    room.on("connection", con => con.open());
                    export function send(receiver, eventName,  ...args){
                        for (const con of room.getConnections()){
                            if (con.parameters[0] === receiver) con.send("$rpc", undefined, 4, [eventName], args)
						}
					}
                    export const broadcast = room.broadcast;
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const [bobClient] = await new Client(room, "Bob").enter();
		const [aliceClient] = await new Client(room, "Alice").enter();
		const aliceMessages: any[] = [];
		aliceClient.on("message", value => aliceMessages.push(value));

		await bobClient.call("send", "Alice", "message", "hello");
		assert.deepEqual(aliceMessages, ["hello"], "alice receives first message");

		await bobClient.call("broadcast", "$rpc", undefined, 4, ["message"], ["hi"]);
		assert.deepEqual(aliceMessages, ["hello", "hi"], "alice receives next message");
	});

	it("room player data", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
                    room.on("connection", con => con.open());
                    export function getPlayerData(name){
                        for (const con of room.getConnections()){
                            if (con.parameters[0] === name) return con.parameters[1];
						}
					}
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const [bobClient] = await new Client(room, "Bob", {foo: "bar"}).enter();
		const bobData = await bobClient.call("getPlayerData", "Bob");
		assert.deepEqual(bobData, {foo: "bar"}, "Bob data is same");
	});

	it("room on off", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
                    room.on("connection", con => con.open());

					let last = undefined;
					const onJoin = (con) => last = con.parameters[0];
                    room.on("connectionOpen", onJoin);

                    export const getLast = () => last;
                    export const stopListen = () => room.off("connectionOpen", onJoin);
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const [bobClient] = await new Client(room, "Bob").enter();
		assert.equal(await bobClient.call("getLast"), "Bob", "Bob is last");

		await new Client(room, "Alice").enter();
		assert.equal(await bobClient.call("getLast"), "Alice", "Alice is last");

		await bobClient.call("stopListen");
		await new Client(room, "Eve").enter();
		assert.equal(await bobClient.call("getLast"), "Alice", "Alice is still last");
	});


	it("room once", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
                    room.on("connection", con => con.open());

                    let last = undefined;
                    const onOffline = (con) => last = con.parameters[0];
                    room.once("connectionClose", onOffline);

                    export const getLast = () => last;
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const [bobClient] = await new Client(room, "Bob").enter();
		assert.equal(await bobClient.call("getLast"), undefined, "no offline");

		const [aliceClient] = await new Client(room, "Alice").enter();
		aliceClient.leave();
		assert.equal(await bobClient.call("getLast"), "Alice", "Alice disconnected first");

		const [eveClient] = await new Client(room, "Eve").enter();
		eveClient.leave();
		assert.equal(await bobClient.call("getLast"), "Alice", "Alice still disconnected first");
	});

	it("config", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import config from "varhub:config";
                    export const getConfig = () => config
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {config: {foo: "bar"}})
		await ctrl.startAsync();

		const [bobClient] = await new Client(room, "Bob").enter();
		assert.deepEqual(await bobClient.call("getConfig"), {foo: "bar"}, "config is same");
	});

	it("empty config", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import config from "varhub:config";
                    export const getConfig = () => config
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code)
		await ctrl.startAsync();

		const [bobClient] = await new Client(room, "Bob").enter();
		assert.deepEqual(await bobClient.call("getConfig"), undefined, "config is empty");
	});

	it("kick other connections", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
                    room.on("connection", con => con.open());

                    export function kickOther(){
    					const connections = room.getConnections();
                        for (const c of connections){
                            if (c === this) continue;
                            c.close("kick-reason");
						}
					}
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code);
		await ctrl.startAsync();

		const [bobClient1] = await new Client(room, "Bob").enter();
		const [bobClient2] = await new Client(room, "Bob").enter();
		const [bobClient3] = await new Client(room, "Bob").enter();
		assert.equal(bobClient1.status, "joined");
		assert.equal(bobClient2.status, "joined");
		assert.equal(bobClient3.status, "joined");
		await bobClient1.call("kickOther");
		assert.equal(bobClient1.status, "joined");
		assert.equal(bobClient2.status, "disconnected");
		assert.equal(bobClient3.status, "disconnected");
		await new Promise(r => setTimeout(r, 10)); // wait for dispose
	});

	it("import remote", {timeout: 10500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import { createEvent, createStore} from 'https://cdn.jsdelivr.net/npm/effector/effector.mjs'

                    export const add = createEvent();
                    const $counter = createStore(0);
                    $counter.on(add, (count, num) => count + num);

                    export const getCounter = () => $counter.getState();
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code);
		await ctrl.startAsync();
		const [client] = await new Client(room, "Bob").enter();
		await client.call("add", 5);
		await client.call("add", 10);
		assert.equal(await client.call("getCounter"), 15, "effector counter works");
	});
	
	it("import with network plugin", {timeout: 10500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import a from 'https://test/a'
                    import b from 'https://test/b'
                    export const test = () => [a, b];
				`
			}
		}
		
		const room = new Room();
		
		const fetched = [];
		class MockNetwork implements ApiHelper {
			async fetch(url: string){
				fetched.push(url);
				if (url.endsWith("a")) return {
					url,
					ok: true,
					type: "text",
					statusText: "OK",
					redirected: false,
					status: 200,
					headers: {"content-type": "application/javascript; charset=utf-8"},
					body: /* language=javascript*/ `export default "hello"+"world"`,
				}
				if (url.endsWith("b")) return {
					url,
					ok: true,
					type: "text",
					statusText: "OK",
					redirected: false,
					status: 200,
					headers: {"content-type": "application/json; charset=utf-8"},
					body: /* language=json*/ `{"a": [10]}`,
				}
				throw new Error("wrong network params");
			}
			[Symbol.dispose](){}
		}
		
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, {network: MockNetwork})
		});
		await ctrl.startAsync();
		const [client] = await new Client(room, "Bob").enter();
		assert.deepEqual(await client.call("test"), ["helloworld", {a: [10]}], "effector counter works");
	})

	it("receive events on join", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
                    room.on("connection", (con) => {
                        con.open();
                        con.send("$rpc", undefined, 4, ["joined"], [])
                    });
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code)
		await ctrl.startAsync();
		let joined = false;
		await new Client(room, "Bob")
			.on("joined", () => joined = true)
				.enter()
			;
		await new Promise(r => setTimeout(r, 100));
		assert.ok(joined, "client receive entered message");
	});
	
	it("varhub:performance", {timeout: 100}, async () => {
		
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import * as performance from "varhub:performance";
                    export function f() {
                        const a = performance.now();
                        for (let i=0; i<100; i++);
                        const b = performance.now();
                        return [a, b];
                    }
				`
			}
		}
		
		const room = new Room();
		using ctrl = new IsolatedVMController(room, code);
		await ctrl.startAsync();
		const [client] = await new Client(room, "Bob").enter()
		const result = await client.call("f") as any;
		assert.equal(typeof result[0], "number", "a is number");
		assert.equal(typeof result[1], "number", "a is number");
		assert.ok(result[1] > result[0], "performance works");
	});
	
	it("export class RPCSource", {timeout: 300}, async () => {
		
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import RPCSource from "varhub:rpc";
                    export class Deck extends RPCSource {
                        constructor(baseState){
                            const con = new.target.connection;
                            super({
                                getMyName() {
                                    return String(con.parameters[0]);
                                },
                                changeState: (value) => {
                                    this.setState(value)
                                }
                            }, baseState);
                        }
                    }
				`
			}
		}
		
		const room = new Room();
		using ctrl = new IsolatedVMController(room, code);
		await ctrl.startAsync();
		const [client] = await new Client(room, "Bob").enter()
		const channelData1 = await new Promise(resolve => {
			const unsubscribe = client.onRawEvent((key, channel, command, data, ...log) => {
				if (key !== "$rpc" || channel !== 88 || command !== 2) return;
				unsubscribe();
				resolve(data);
			});
			client.sendRaw("$rpc", undefined, 2, 88, ["Deck"], [99]);
		})
		
		assert.equal(channelData1, 99, "1st channel state");
		
		const callResult = await new Promise(resolve => {
			const unsubscribe = client.onRawEvent((key, channel, command, callId, data) => {
				if (key !== "$rpc" || channel !== 88 || command !== 0 || callId !== 777) return;
				unsubscribe();
				resolve(data);
			})
			client.sendRaw("$rpc", 88, 0, 777, ["getMyName"], []);
		});
		assert.equal(callResult, "Bob", "get name success");
		
		const channelData2 = await new Promise(resolve => {
			const unsubscribe = client.onRawEvent((key, channel, command, data) => {
				if (key !== "$rpc" || channel !== 88 || command !== 2) return;
				unsubscribe();
				resolve(data);
			});
			client.sendRaw("$rpc", 88, 0, 666, ["changeState"], [22]);
		})
		assert.equal(channelData2, 22, "2nd channel state");
	});
});
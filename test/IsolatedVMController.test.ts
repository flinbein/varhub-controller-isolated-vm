import assert from "node:assert";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { ControllerCode, IsolatedVMController } from "../src/IsolatedVMController.js";
import { Room, ApiSource, ApiHelper, ApiHelperController, Connection, RPCController } from "@flinbein/varhub";

class Counter implements ApiHelper {
	#value = 0;
	next = () => ++this.#value;
	current = () => this.#value;
	error = () => { throw this.#value }
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
	#connection: Connection | undefined
	readonly #room: Room;
	readonly #id: string;
	readonly #password: string | undefined;
	readonly #config: unknown;
	readonly #eventLog: unknown[] = [];
	#nextRpcId = 0;
	#rpcResultEmitter = new EventEmitter();
	#rpcEventEmitter = new EventEmitter();
	#closeReason: string | null | undefined = undefined;
	constructor(room: Room, id: string, password?: string|undefined, config?: unknown) {
		this.#room = room;
		this.#id = id;
		this.#password = password;
		this.#config = config;
		
	}
	
	join(){
		this.#connection = this.#room.createConnection()
			.on("disconnect", (ignored, reason) => {
				this.#closeReason = reason;
				for (let eventName of this.#rpcResultEmitter.eventNames()) {
					this.#rpcResultEmitter.emit(eventName, 3);
				}
			})
			.on("event", (eventName, ...eventArgs) => {
				const [eventId, ...args] = eventArgs;
				if (eventName === "$rpcResult") {
					this.#rpcResultEmitter.emit(eventId, ...args);
				} else if (eventName === "$rpcEvent") {
					this.#eventLog.push(eventArgs);
					this.#rpcEventEmitter.emit(eventId, ...args);
				}
			})
			.enter(this.#id, this.#password, this.#config)
		;
		return this;
	}

	get eventLog(){
		return this.#eventLog;
	}

	get closeReason(){
		return this.#closeReason;
	}

	get config(){
		return this.#config;
	}
	get id(){
		return this.#id;
	}
	get password(){
		return this.#password;
	}
	call(methodName: string, ...args: any[]): unknown {
		const rpcId = this.#nextRpcId++;
		let code: [unknown, unknown] | undefined = undefined
		let resolver: [(arg: unknown) => void, (arg: unknown) => void] | undefined = undefined;
		this.#rpcResultEmitter.once(rpcId as any, (errorCode, result) => {
			code = [errorCode, result];
			if (!resolver) return;
			if (errorCode === 3) resolver[1](new Error(`room destroyed or player disconnceted`));
			if (errorCode === 2) resolver[1](new Error(`no method: ${methodName}`));
			if (errorCode) resolver[1](result);
			resolver[0](result);
		})
		this.#connection!.message("$rpc", rpcId, methodName, ...args);
		if (code) {
			if (code[0] === 3) return undefined;
			if (code[0] === 2) throw new Error(`no method: ${methodName}`);
			if (code[0]) throw code[1];
			return code[1];
		}
		return new Promise((success, fail) => {
			resolver = [success, fail];
		})
	}

	get status(){
		return this.#connection!.status
	}

	leave(reason?: string | null){
		return this.#connection!.leave(reason);
	}

	on(eventName: string, handler: (...args: unknown[]) => void): this{
		this.#rpcEventEmitter.on(eventName, handler);
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

					export function greet(){
    					return "Hello, " + this.player + "!";
					}

                    export function getPlayers(){
                        return room.getPlayers();
					}
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const bobClient = new Client(room, "Bob").join();
		const greetMessage = await bobClient.call("greet");
		assert.equal(greetMessage, "Hello, Bob!", "greet message for Bob");

		const bobClient2 = new Client(room, "Bob").join();
		const greetMessage2 = await bobClient2.call("greet");
		assert.equal(greetMessage2, "Hello, Bob!", "greet message 2 for Bob");

		const aliceClient = new Client(room, "Alice").join();
		const greetMessage3 = await aliceClient.call("greet");
		assert.equal(greetMessage3, "Hello, Alice!", "greet message for Alice");

		const players = await aliceClient.call("getPlayers");
		assert.deepEqual(players, ["Bob", "Alice"], "get all players");
	});

	it("async ctrl methods", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    export async function greet(){
                        await new Promise(r => setTimeout(r, 1));
                        return "Hello, " + this.player + "!";
                    }
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const bobClient = new Client(room, "Bob").join();
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
		const client = new Client(room, "Bob").join();;
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
		const client = new Client(room, "Bob").join();
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
		const client = new Client(room, "Bob").join();
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
		const client = new Client(room, "Bob").join();
		assert.equal(await client.call("fetchWithError", "https://google.com"), 400, "fetched url error");
	});

	it("room message", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
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
		const client = new Client(room, "Bob").join();
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
                    export const getRoomClosed = () => room.closed
                    export const setRoomClosed = (msg) => room.closed = msg;
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const bobClient = new Client(room, "Bob").join();
		assert.equal(await bobClient.call("getRoomClosed"), false, "default closed is false");

		const eveClient = new Client(room, "Eve").join();
		assert.equal(eveClient.status, "joined", "Eve joined");

		await bobClient.call("setRoomClosed", true);
		assert.equal(await bobClient.call("getRoomClosed"), true, "next closed is true");

		const aliceClient = new Client(room, "Alice").join();
		assert.equal(aliceClient.status, "disconnected", "alice can not join");
	});

	it("room destroy", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
                    export const destroy = () => room.destroy();
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const bobClient = new Client(room, "Bob").join();
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
                    export const isPlayerOnline = room.isPlayerOnline;
                    export const hasPlayer = room.hasPlayer;
                    export const kick = room.kick;
				`
			}
		}

		using room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const bobClient = new Client(room, "Bob").join();
		assert.equal(await bobClient.call("isPlayerOnline", "Alice"), undefined, "Alice online is undefined");
		assert.equal(await bobClient.call("hasPlayer", "Alice"), false, "no player Alice");

		const aliceClient = new Client(room, "Alice").join();

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
                    export const send = room.send;
                    export const broadcast = room.broadcast;
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const bobClient = new Client(room, "Bob").join();
		const aliceClient = new Client(room, "Alice").join();
		const aliceMessages: any[] = [];
		aliceClient.on("message", value => aliceMessages.push(value));

		await bobClient.call("send", "Alice", "message", "hello");
		assert.deepEqual(aliceMessages, ["hello"], "alice receives first message");

		await bobClient.call("broadcast", "message", "hi");
		assert.deepEqual(aliceMessages, ["hello", "hi"], "alice receives next message");
	});

	it("room player data", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
                    export const getPlayerData = room.getPlayerData;
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const bobClient = new Client(room, "Bob", "", {foo: "bar"}).join();
		const bobData = await bobClient.call("getPlayerData", "Bob");
		assert.deepEqual(bobData, {foo: "bar"}, "Bob data is same");
	});

	it("room on off", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";

					let last = undefined;
					const onJoin = (name) => last = name;
                    room.on("join", onJoin);

                    export const getLast = () => last;
                    export const stopListen = () => room.off("join", onJoin);
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const bobClient = new Client(room, "Bob").join();
		assert.equal(await bobClient.call("getLast"), "Bob", "Bob is last");

		new Client(room, "Alice").join();
		assert.equal(await bobClient.call("getLast"), "Alice", "Alice is last");

		await bobClient.call("stopListen");
		new Client(room, "Eve").join();
		assert.equal(await bobClient.call("getLast"), "Alice", "Alice is still last");
	});


	it("room once", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";

                    let last = undefined;
                    const onOffline = (name) => last = name;
                    room.once("offline", onOffline);

                    export const getLast = () => last;
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		});
		await ctrl.startAsync();
		const bobClient = new Client(room, "Bob").join();
		assert.equal(await bobClient.call("getLast"), undefined, "no offline");

		new Client(room, "Alice").join().leave();
		assert.equal(await bobClient.call("getLast"), "Alice", "Alice disconnected first");

		new Client(room, "Eve").join().leave();
		assert.equal(await bobClient.call("getLast"), "Alice", "Alice still disconnected first");
	});

	it("multi controllers with same api", {timeout: 500}, async () => {
		const codeFoo: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import counter from "varhub:api/Counter";
                    export const foo = () => "Foo"

                    export const fooCurrent = () => counter.current()
				`
			}
		}

		const codeBar: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import counter from "varhub:api/Counter";
                    export const bar = () => "Bar"

                    export const barNext = () => counter.next()
				`
			}
		}

		const room = new Room();
		const apiHelperController = new ApiHelperController(room, apiSource);
		const rpcController = new RPCController(room);
		using ctrl1 = new IsolatedVMController(room, codeFoo, {apiHelperController, rpcController});
		await ctrl1.startAsync();
		using ctrl2 = new IsolatedVMController(room, codeBar, {apiHelperController, rpcController});
		await ctrl2.startAsync();

		const bobClient = new Client(room, "Bob").join();
		assert.equal(await bobClient.call("foo"), "Foo", "call runtime Foo");
		assert.equal(await bobClient.call("bar"), "Bar", "call runtime Bar");

		assert.equal(await bobClient.call("fooCurrent"), 0, "current counter in Foo = 0");
		await bobClient.call("barNext"); // increment counter in Bar
		assert.equal(await bobClient.call("fooCurrent"), 1, "current counter in Foo = 1");
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

		const bobClient = new Client(room, "Bob").join();
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

		const bobClient = new Client(room, "Bob").join();
		assert.deepEqual(await bobClient.call("getConfig"), undefined, "config is empty");
	});

	it("kick other connections", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
                    export function kickOther(){
    					const {player, connection} = this;
                        const connections = room.getPlayerConnections(player);
                        for (const c of connections){
                            if (c === connection) continue;
                            room.kick(c);
						}
					}
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code);
		await ctrl.startAsync();

		const bobClient1 = new Client(room, "Bob").join();
		const bobClient2 = new Client(room, "Bob").join();
		const bobClient3 = new Client(room, "Bob").join();
		assert.equal(bobClient1.status, "joined");
		assert.equal(bobClient2.status, "joined");
		assert.equal(bobClient3.status, "joined");
		await bobClient1.call("kickOther");
		assert.equal(bobClient1.status, "joined");
		assert.equal(bobClient2.status, "disconnected");
		assert.equal(bobClient3.status, "disconnected");
	});

	it("send other connections", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
                    export function sendOther(){
    					const {player, connection} = this;
                        const connections = room.getPlayerConnections(player);
                        for (const c of connections){
                            if (c === connection) continue;
                            room.send(c, "msg");
						}
					}
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code);
		await ctrl.startAsync();

		const bobClient1 = new Client(room, "Bob").join();
		const bobClient2 = new Client(room, "Bob").join();
		assert.deepEqual(bobClient1.eventLog, []);
		assert.deepEqual(bobClient2.eventLog, []);
		await bobClient1.call("sendOther");
		assert.deepEqual(bobClient1.eventLog, []);
		assert.deepEqual(bobClient2.eventLog, [["msg"]]);
	});

	it("kick other on join", {timeout: 500}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					room.on("connectionJoin", (player, connection) => {
                        const connections = room.getPlayerConnections(player);
                        for (const c of connections){
                            if (c === connection) continue;
                            room.kick(c, "only 1 connection allowed");
                        }
					});
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code);
		await ctrl.startAsync();

		const bobClient1 = new Client(room, "Bob").join();
		await new Promise(r => setTimeout(r, 100));
		assert.deepEqual(bobClient1.status, "joined");
		const bobClient2 = new Client(room, "Bob").join();
		await new Promise(r => setTimeout(r, 100));
		assert.deepEqual(bobClient2.status, "joined");
		assert.deepEqual(bobClient1.status, "disconnected");
		assert.deepEqual(bobClient1.closeReason, "only 1 connection allowed");
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
		const client = new Client(room, "Bob").join();
		await client.call("add", 5);
		await client.call("add", 10);
		assert.equal(await client.call("getCounter"), 15, "effector counter works");
	});

	it("receive events on join", {timeout: 200}, async () => {
		const code: ControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
                    room.on("join", (player) => {
                        room.send(player, "joined")
                    });
				`
			}
		}

		const room = new Room();
		using ctrl = new IsolatedVMController(room, code)
		await ctrl.startAsync();
		let joined = false;
		new Client(room, "Bob")
		.on("joined", () => joined = true)
			.join()
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
		const result = await new Client(room, "Bob").join().call("f") as any;
		assert.equal(typeof result[0], "number", "a is number");
		assert.equal(typeof result[1], "number", "a is number");
		assert.ok(result[1] > result[0], "performance works");
	});
});
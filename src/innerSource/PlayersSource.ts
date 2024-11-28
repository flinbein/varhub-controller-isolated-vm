export default /* language=javascript */ `import EventEmitter from "varhub:events";
export default class Players {
	#playerMap = new Map();
	#playerConnections = new WeakMap();
	#playerGroups = new WeakMap();
	#playerEvents = new WeakMap();
	#connectionPlayerNameMap = new WeakMap();
	#registerPlayer;
	#events = new EventEmitter();
	#room;
	#controller = {
		isRegistered: (player) => this.#playerMap.get(player.name) === player,
		getGroupOf: (player) => this.#playerGroups.get(player),
		setGroupOf: (player, group) => {
			if (group === undefined)
				return this.#playerGroups.delete(player);
			this.#playerGroups.set(player, group);
		},
		getConnectionsOf: (player) => this.#playerConnections.get(player),
		registerEvents: (player, events) => this.#playerEvents.set(player, events),
		kick: (player, reason) => {
			const existsPlayer = this.#playerMap.get(player.name);
			if (existsPlayer !== player)
				return;
			this.#playerMap.delete(player.name);
			const connections = this.#playerConnections.get(player);
			for (let connection of connections)
				connection.close(reason);
			connections.clear();
			this.#playerEvents.get(player)?.emitWithTry("leave");
			this.#events.emitWithTry("leave", player);
		}
	};
	constructor(room, registerPlayerHandler) {
		this.#registerPlayer = registerPlayerHandler;
		this.#room = room;
		room.on("connection", this.#onConnection);
		room.on("connectionOpen", this.#onConnectionOpen);
		room.on("connectionMessage", this.#onConnectionMessage);
		room.on("connectionClose", this.#onConnectionClose);
	}
	get room() { return this.#room; }
	withType(){ return this; }
	#onConnection = async (connection, ...args) => {
		let registerResult;
		try {
			registerResult = this.#registerPlayer(connection, ...args);
		}
		catch (e) {
			return connection.close(e == null ? null : String(e));
		}
		if (connection.ready || connection.closed)
			return;
		if (!(registerResult && typeof registerResult === "object" && "then" in registerResult)) {
			if (registerResult != null)
				this.#connectionPlayerNameMap.set(connection, String(registerResult));
			return;
		}
		connection.defer(async () => {
			const syncResult = await registerResult;
			if (connection.deferred && syncResult != null) {
				this.#connectionPlayerNameMap.set(connection, String(syncResult));
			}
		}).catch(() => { });
	};
	#onConnectionOpen = (connection) => {
		const playerName = this.#connectionPlayerNameMap.get(connection);
		if (playerName == null)
			return;
		const existsPlayer = this.#playerMap.get(playerName);
		if (existsPlayer) {
			const connections = this.#playerConnections.get(existsPlayer);
			connections.add(connection);
			if (connections.size === 1) {
				this.#events.emitWithTry("online", existsPlayer);
				this.#playerEvents.get(existsPlayer)?.emitWithTry("online");
			}
			return;
		}
		const player = new Player(playerName, this.#controller);
		this.#playerConnections.set(player, new Set([connection]));
		this.#playerMap.set(playerName, player);
		this.#events.emitWithTry("join", player);
	};
	#onConnectionMessage = (connection, ...args) => {
		const player = this.get(connection);
		if (player)
			this.#playerEvents.get(player)?.emitWithTry("connectionMessage", connection, ...args);
	};
	#onConnectionClose = (connection) => {
		const playerName = this.#connectionPlayerNameMap.get(connection);
		if (typeof playerName !== "string")
			return;
		const existsPlayer = this.#playerMap.get(playerName);
		if (!existsPlayer)
			return;
		const connections = this.#playerConnections.get(existsPlayer);
		const wasOnline = connections.size > 0;
		connections.delete(connection);
		const online = connections.size > 0;
		if (wasOnline && !online) {
			this.#events.emitWithTry("offline", existsPlayer);
			this.#playerEvents.get(existsPlayer)?.emitWithTry("offline");
		}
	};
	get(nameOrConnection) {
		if (typeof nameOrConnection === "string")
			return this.#playerMap.get(nameOrConnection);
		const playerName = this.#connectionPlayerNameMap.get(nameOrConnection);
		if (playerName != null)
			return this.#playerMap.get(playerName);
	}
	get count() {
		return this.#playerMap.size;
	}
	getTeam(team) {
		return new Set([...this.#playerMap.values()].filter(player => this.#playerGroups.get(player) === team));
	}
	all() {
		return new Set(this.#playerMap.values());
	}
	on(eventName, handler) {
		this.#events.on.call(this, eventName, handler);
		return this;
	}
	once(eventName, handler) {
		this.#events.once.call(this, eventName, handler);
		return this;
	}
	off(eventName, handler) {
		this.#events.off.call(this, eventName, handler);
		return this;
	}
	[Symbol.iterator]() {
		return this.#playerMap.values();
	}
}
class Player {
	#name;
	#controller;
	#eventBox = new EventEmitter();
	constructor(name, controller) {
		this.#name = name;
		this.#controller = controller;
		controller.registerEvents(this, this.#eventBox);
	}
	get name() { return String(this.#name); }
	get connections() { return new Set(this.#controller.getConnectionsOf(this)); }
	get online() { return this.#controller.getConnectionsOf(this).size > 0; }
	get registered() { return this.#controller.isRegistered(this); }
	get team() { return this.#controller.getGroupOf(this); }
	setTeam(value) { this.#controller.setGroupOf(this, value); return this; }
	send(...args) {
		for (let connection of this.connections) {
			connection.send(...args);
		}
		return this;
	}
	on(eventName, handler) {
		this.#eventBox.on.call(this, eventName, handler);
		return this;
	}
	once(eventName, handler) {
		this.#eventBox.once.call(this, eventName, handler);
		return this;
	}
	off(eventName, handler) {
		this.#eventBox.off.call(this, eventName, handler);
		return this;
	}
	kick(reason = null) {
		this.#controller.kick(this, reason);
	}
	toString() {
		return String(this.#name);
	}
	valueOf() {
		return this.#name;
	}
	[Symbol.iterator]() {
		return this.connections[Symbol.iterator]();
	}
}`;
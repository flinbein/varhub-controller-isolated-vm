import IVM from "isolated-vm";
export class RoomModuleHelper {
    #room;
    #moduleName;
    #program;
    #playerController;
    constructor(room, playerController, program, moduleName) {
        this.#room = room;
        this.#moduleName = moduleName;
        this.#program = program;
        this.#playerController = playerController;
    }
    async execute() {
        const innerModule = await this.#program.createModule(`${this.#moduleName}#inner`, roomInnerSource);
        await innerModule.callMethod("set", undefined, {
            destroyRoom: new IVM.Callback(() => this.destroyRoom()),
            getRoomMessage: new IVM.Callback(() => this.getRoomMessage()),
            setRoomMessage: new IVM.Callback((msg) => this.setRoomMessage(msg)),
            getRoomClosed: new IVM.Callback(() => this.getRoomClosed()),
            setRoomClosed: new IVM.Callback((...args) => this.setRoomClosed(...args)),
            kickPlayer: new IVM.Callback((...args) => this.kick(...args)),
            broadcast: new IVM.Callback((...args) => this.broadcast(...args)),
            getPlayerData: new IVM.Callback((...args) => this.getPlayerData(...args)),
            getPlayerOnline: new IVM.Callback((...args) => this.getPlayerOnline(...args)),
            getPlayers: new IVM.Callback(() => (this.getPlayers())),
            sendEventToPlayer: new IVM.Callback((...args) => this.sendEvent(...args)),
            isOnline: new IVM.Callback((...args) => this.isOnline(...args)),
            getPlayerConnections: new IVM.Callback((...args) => this.getPlayerConnections(...args)),
        });
        await this.#program.createModule(this.#moduleName, roomSource);
        for (const eventName of ["join", "leave", "online", "offline"]) {
            this.#playerController.on(eventName, (player) => {
                innerModule.callMethodIgnored("emit", undefined, eventName, player.id);
            });
        }
        this.#room.prependListener("connectionJoin", (connection) => {
            const player = this.#playerController.getPlayerOfConnection(connection);
            innerModule.callMethodIgnored("emit", undefined, "connectionJoin", player?.id, connection.id);
        });
        this.#room.prependListener("connectionClosed", (connection, online, reason) => {
            const player = this.#playerController.getPlayerOfConnection(connection);
            innerModule.callMethodIgnored("emit", undefined, "connectionClosed", player?.id, connection.id, reason);
        });
    }
    destroyRoom() {
        this.#room.destroy();
    }
    setRoomMessage(message) {
        this.#room.publicMessage = message == null ? null : String(message);
    }
    getRoomMessage() {
        return this.#room.publicMessage;
    }
    setRoomClosed(closed) {
        if (closed != null)
            this.#playerController.closed = Boolean(closed);
    }
    getRoomClosed() {
        return this.#playerController.closed;
    }
    getPlayerConnections(playerId) {
        const player = this.#playerController.getPlayerById(String(playerId));
        const connections = player?.getConnections();
        if (!connections)
            return undefined;
        return [...connections].map(({ id }) => id);
    }
    kick(nameOrId, reason) {
        if (typeof nameOrId === "string") {
            const player = this.#playerController.getPlayerById(String(nameOrId));
            if (!player)
                return false;
            return this.#playerController.kick(player, reason == null ? reason : String(reason));
        }
        else if (typeof nameOrId === "number") {
            const connection = this.#getConnection(nameOrId);
            if (!connection)
                return false;
            connection.leave(reason == null ? null : String(reason));
            return true;
        }
    }
    getPlayerData(name) {
        const player = this.#playerController.getPlayerById(String(name));
        if (!player)
            return undefined;
        return player.config;
    }
    getPlayerOnline(name) {
        const player = this.#playerController.getPlayerById(String(name));
        if (!player)
            return undefined;
        return player.online;
    }
    getPlayers() {
        return Array.from(this.#playerController.getPlayers().keys());
    }
    broadcast(...args) {
        this.#playerController.broadcastEvent("$rpcEvent", ...args);
    }
    sendEvent(nameOrId, ...args) {
        if (typeof nameOrId === "string") {
            const player = this.#playerController.getPlayerById(String(nameOrId));
            if (!player)
                return false;
            if (!player.online)
                return false;
            player.sendEvent("$rpcEvent", ...args);
            return true;
        }
        else if (typeof nameOrId === "number") {
            const connection = this.#getConnection(nameOrId);
            if (!connection)
                return false;
            connection.sendEvent("$rpcEvent", ...args);
            return true;
        }
    }
    isOnline(nameOrId) {
        if (typeof nameOrId === "string") {
            const player = this.#playerController.getPlayerById(String(nameOrId));
            return player?.online ?? false;
        }
        else if (typeof nameOrId === "number") {
            const connection = this.#getConnection(nameOrId);
            if (!connection)
                return false;
            return connection.status === "joined";
        }
    }
    #getConnection(connectionId) {
        let connection = this.#room.getJoinedConnections().find(({ id }) => id === connectionId);
        if (connection == undefined)
            connection = this.#room.getLobbyConnections().find(({ id }) => id === connectionId);
        return connection;
    }
}
// language=JavaScript
const roomSource = `
	import {$, e} from "#inner";
	export default Object.freeze({
        get message(){
            return $.getRoomMessage();
        },
        set message(message){
            $.setRoomMessage(message);
        },
        get closed(){
            return $.getRoomClosed();
        },
        set closed(v){
            $.setRoomClosed(v);
        },
        destroy: $.destroyRoom,
        isPlayerOnline: (name) => $.getPlayerOnline(name),
        isOnline: (name) => $.isOnline(name),
        hasPlayer: (name) => $.getPlayerOnline(name) != null,
        kick: $.kickPlayer,
        send: $.sendEventToPlayer,
        broadcast: $.broadcast,
        getPlayerData: $.getPlayerData,
        getPlayers: $.getPlayers,
        getPlayerConnections: $.getPlayerConnections,
		on: e.on.bind(e),
        once: e.once.bind(e),
        off: e.off.bind(e)
	})
`;
// language=JavaScript
const roomInnerSource = `
	import { EventEmitter } from "varhub:events";
	export let $;
    export const set = a => {$ = a}
    export const e = new EventEmitter();
    export const emit = (...args) => {e.emit(...args)}
`;

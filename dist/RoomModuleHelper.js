import IVM from "isolated-vm";
import { roomInnerSource, roomSource } from "./innerSource/RoomSource.js";
export class RoomModuleHelper {
    #room;
    #moduleName;
    #program;
    constructor(room, program, moduleName) {
        this.#room = room;
        this.#moduleName = moduleName;
        this.#program = program;
    }
    async execute() {
        const innerModule = await this.#program.createModule(`${this.#moduleName}#inner`, roomInnerSource);
        await innerModule.callMethod("set", undefined, {
            destroy: new IVM.Callback(() => this.destroy()),
            getRoomMessage: new IVM.Callback(() => this.getRoomMessage()),
            setRoomMessage: new IVM.Callback((msg) => this.setRoomMessage(msg)),
            kick: new IVM.Callback((...args) => this.kick(...args)),
            open: new IVM.Callback((...args) => this.open(...args)),
            broadcast: new IVM.Callback((...args) => this.broadcast(...args)),
            send: new IVM.Callback((...args) => this.send(...args)),
            isOnline: new IVM.Callback((...args) => this.isOnline(...args)),
        });
        await this.#program.createModule(this.#moduleName, roomSource);
        this.#room.prependListener("connectionJoin", (connection) => {
            innerModule.callMethodIgnored("onJoin", undefined, connection.id);
        });
        this.#room.prependListener("connectionClosed", (connection, wasOnline, reason) => {
            innerModule.callMethodIgnored("onClose", undefined, connection.id, wasOnline, reason);
        });
        this.#room.prependListener("connectionEnter", (connection, ...args) => {
            innerModule.callMethodIgnored("onEnter", undefined, connection.id, ...args);
        });
        this.#room.prependListener("connectionMessage", (connection, ...args) => {
            innerModule.callMethodIgnored("onMessage", undefined, connection.id, ...args);
        });
    }
    destroy() {
        this.#room.destroy();
    }
    setRoomMessage(message) {
        this.#room.publicMessage = message == null ? null : String(message);
    }
    getRoomMessage() {
        return this.#room.publicMessage;
    }
    kick(nameOrId, reason) {
        const connection = this.#getConnection(Number(nameOrId));
        if (!connection)
            return false;
        connection.leave(reason == null ? null : String(reason));
        return true;
    }
    open(nameOrId) {
        const connection = this.#getConnection(Number(nameOrId));
        if (!connection)
            return false;
        return this.#room.join(connection);
    }
    broadcast(...args) {
        for (let con of this.#room.getJoinedConnections()) {
            con.sendEvent(...args);
        }
    }
    send(nameOrId, ...args) {
        const connection = this.#getConnection(Number(nameOrId));
        if (!connection)
            return false;
        connection.sendEvent(...args);
        return true;
    }
    isOnline(nameOrId) {
        const connection = this.#getConnection(Number(nameOrId));
        if (!connection)
            return false;
        return connection.status === "joined";
    }
    #getConnection(connectionId) {
        let connection = this.#room.getJoinedConnections().find(({ id }) => id === connectionId);
        if (connection == undefined)
            connection = this.#room.getLobbyConnections().find(({ id }) => id === connectionId);
        return connection;
    }
}
//# sourceMappingURL=RoomModuleHelper.js.map
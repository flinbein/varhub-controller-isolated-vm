import IVM, { type Callback } from "isolated-vm";
import type { Connection, PlayerController, Room } from "@flinbein/varhub";
import { IsolatedVMProgram } from "./IsolatedVMProgram.js";
import {roomInnerSource, roomSource} from "./innerSource/RoomSource.js"

export class RoomModuleHelper {
	readonly #room: Room;
	readonly #moduleName: string;
	readonly #program: IsolatedVMProgram;
	
	constructor(room: Room, program: IsolatedVMProgram, moduleName: string) {
		this.#room = room;
		this.#moduleName = moduleName;
		this.#program = program;
	}
	
	async execute(){
		const innerModule = await this.#program.createModule(`${this.#moduleName}#inner`, roomInnerSource);
		await innerModule.callMethod("set", undefined, {
			destroy: new IVM.Callback(() => this.destroy()),
			getRoomMessage: new IVM.Callback(() => this.getRoomMessage()),
			setRoomMessage: new IVM.Callback((msg: any) => this.setRoomMessage(msg)),
			kick: new IVM.Callback((...args: any[]) => this.kick(...args)),
			open: new IVM.Callback((...args: any[]) => this.open(...args)),
			broadcast: new IVM.Callback((...args: any[]) => this.broadcast(...args)),
			send: new IVM.Callback((...args: any[]) => this.send(...args)),
			isOnline: new IVM.Callback((...args: any[]) => this.isOnline(...args)),
		})
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
	
	destroy(){
		this.#room.destroy();
	}
	setRoomMessage(message: unknown){
		this.#room.publicMessage = message == null ? null : String(message);
	}
	getRoomMessage(){
		return this.#room.publicMessage
	}
	kick(nameOrId?: unknown, reason?: unknown){
		const connection = this.#getConnection(Number(nameOrId));
		if (!connection) return false;
		connection.leave(reason == null ? null : String(reason));
		return true;
	}
	open(nameOrId?: unknown){
		const connection = this.#getConnection(Number(nameOrId));
		if (!connection) return false;
		return this.#room.join(connection);
	}
	broadcast(...args: unknown[]){
		for (let con of this.#room.getJoinedConnections()) {
			con.sendEvent(...args);
		}
	}
	send(nameOrId?: unknown, ...args: unknown[]){
		const connection = this.#getConnection(Number(nameOrId));
		if (!connection) return false;
		connection.sendEvent(...args);
		return true;
	}
	isOnline(nameOrId?: unknown){
		const connection = this.#getConnection(Number(nameOrId));
		if (!connection) return false;
		return connection.status === "joined";
	}
	#getConnection(connectionId: number): Connection | undefined {
		let connection = this.#room.getJoinedConnections().find(({id}) => id === connectionId);
		if (connection == undefined) connection = this.#room.getLobbyConnections().find(({id}) => id === connectionId);
		return connection
	}
}


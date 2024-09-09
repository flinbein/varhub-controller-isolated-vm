import { type Room, type Connection, ApiHelperController, TypedEventEmitter } from "@flinbein/varhub";

type IsolatedVMControllerEvents = {}

export interface ControllerCode {
	main: string,
	source: Record<string, string>
}

export interface ControllerOptions {
	apiHelperController?: ApiHelperController,
	config?: {};
}

export class IsolatedVMController extends TypedEventEmitter<IsolatedVMControllerEvents> implements Disposable  {
	#room: Room;
	#source: Record<string, string>;
	#configJson: string;
	
	constructor(room: Room, code: ControllerCode, options: ControllerOptions) {
		super();
		this.#room = room;
		this.#source = {...code.source};
		this.#configJson = JSON.stringify(options.config) ?? "undefined";
	}
	
	[Symbol.dispose](){
	}
}
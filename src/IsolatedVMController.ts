import { type Room, ApiHelperController, TypedEventEmitter, type ApiHelper } from "@flinbein/varhub";
import { IsolatedVMProgram, ProgramModule } from "./IsolatedVMProgram.js";
import { parseDescriptor, joinDescriptor } from "./util/DescriptorUtils.js";
import { RoomModuleHelper } from "./RoomModuleHelper.js";
import eventEmitterSource from "./innerSource/EventEmitterSource.js";
import {rpcSourceInner, rpcSourceModified} from "./innerSource/RpcSourceModified.js";
import playersSource from "./innerSource/PlayersSource.js";
import { PerformanceModuleHelper } from "./PerformanceModuleHelper.js";
import { ApiModuleHelper } from "./ApiModuleHelper.js";

type IsolatedVMControllerEvents = {
	dispose: []
}

export interface ControllerCode {
	main: string,
	source: Record<string, string>
}

export interface ControllerOptions {
	apiHelperController?: ApiHelperController,
	config?: {};
	inspector?: boolean;
	memoryLimitMb?: number;
}

const defaultExtensions = ["js", "mjs", "json", "json5"];
const baseModules: Partial<Record<string, {type: string, text: string}>> = {
	"varhub:events": { type: "js", text: eventEmitterSource },
	"varhub:rpc": { type: "js", text: rpcSourceModified },
	"varhub:rpc#inner": { type: "js", text: rpcSourceInner },
	"varhub:players": { type: "js", text: playersSource },
}

export class IsolatedVMController extends TypedEventEmitter<IsolatedVMControllerEvents> implements Disposable  {
	#room: Room;
	#source: Record<string, string>;
	#program: IsolatedVMProgram;
	readonly #apiHelperController: ApiHelperController | undefined;
	readonly #mainModuleName: string;
	readonly #networkApi: ApiHelper | undefined;
	#apiModuleHelper: ApiModuleHelper | undefined;
	
	constructor(room: Room, code: ControllerCode, options: ControllerOptions = {}) {
		super();
		try {
			this.#room = room;
			room.on("destroy", this[Symbol.dispose].bind(this));
			this.#source = {...code.source};
			const configJson = JSON.stringify(options.config) ?? "undefined";
			this.#program = new IsolatedVMProgram(this.#getSource, {
				inspector: options.inspector,
				memoryLimitMb: options.memoryLimitMb
			});
			this.#program.on("dispose", this[Symbol.dispose].bind(this));
			void this.#program.createModule("varhub:config", `export default ${configJson}`, 'js');
			this.#apiHelperController = options.apiHelperController;
			this.#mainModuleName = code.main;
			this.#networkApi = options.apiHelperController?.getOrCreateApi("network");
		} catch (error) {
			this[Symbol.dispose]();
			throw error;
		}
		
	}
	
	#started = false;
	async #startModules(){
		if (this.#started) throw new Error("already starting");
		this.#started = true;
		await new RoomModuleHelper(this.#room, this.#program, "varhub:room").execute();
		await new PerformanceModuleHelper(this.#program, "varhub:performance").execute();
		this.#apiModuleHelper = new ApiModuleHelper(this.#apiHelperController, this.#program, "varhub:api/");
		await this.#apiModuleHelper.execute();
	}
	
	async startAsync(): Promise<this> {
		await this.#startModules();
		const module = await this.#program.getModule(this.#mainModuleName);
		
		const keys = await module.getKeysAsync();
		if (keys.length > 0) await this.#program.startRpc(this.#mainModuleName);
		return this;
	}
	
	createInspectorSession(){
		return this.#program.createInspectorSession();
	}
	
	#getSource = (moduleName: string) => {
		const baseModule = baseModules[moduleName];
		if (baseModule) return {name: moduleName, getSource: () => baseModule};
		
		const possibleApiModuleName = this.#apiModuleHelper?.getPossibleApiModuleName(moduleName);
		if (possibleApiModuleName != null) return {
			name: moduleName,
			getSource: () => ({
				text: this.#apiModuleHelper?.createApiSource(possibleApiModuleName, this.#program) ?? "",
				type: "js",
			})
		};
		const desc = parseDescriptor(moduleName);
		if (desc.protocol) {
			return {
				name: moduleName,
				getSource: async () => this.#fetchFile(moduleName),
			}
		}
		if (desc.extension) {
			const fileSrc = this.#source[desc.file];
			if (!fileSrc) return undefined;
			return {
				name: moduleName,
				getSource: () => ({
					type: desc.extension,
					text: fileSrc
				})
			}
		}
		const fileSrc = this.#source[desc.file];
		if (fileSrc) return {
			name: moduleName,
			getSource: () => ({text: fileSrc})
		}
		for (let ext of defaultExtensions) {
			const fileSrc = this.#source[desc.name + "." + ext];
			if (!fileSrc) continue;
			return {
				name: joinDescriptor({...desc, extension: ext}),
				getSource: () => ({text: fileSrc, type: ext})
			}
		}
		return undefined;
	}
	
	async #fetchFile(url: string): Promise<{text: string, type?: null | string}> {
		if (this.#networkApi) {
			const fetchResponse = await this.#networkApi.fetch(url, {type: "text"});
			return {
				text: fetchResponse.body,
				type: fetchResponse.headers["content-type"]?.split(",")?.[0]
			}
		}
		const response = await fetch(url);
		if (!response.ok) throw response;
		return {
			type: response.headers.get("content-type"),
			text: await response.text(),
		}
	}
	
	#disposed = false;
	get disposed(){
		return this.#disposed;
	}
	
	[Symbol.dispose](){
		if (this.#disposed) return;
		this.#disposed = true;
		this.#program[Symbol.dispose]();
		this.emit("dispose");
	}
}
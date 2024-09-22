import { type Room, RPCController, PlayerController, type Connection, ApiHelperController, TypedEventEmitter, type ApiHelper } from "@flinbein/varhub";
import { IsolatedVMProgram, ProgramModule } from "./IsolatedVMProgram.js";
import { parseDescriptor, joinDescriptor } from "./util/DescriptorUtils.js";
import { RoomModuleHelper } from "./util/RoomModuleHelper.js";
import eventEmitterSource from "./EventEmitterSource.js";
import { PerformanceModuleHelper } from "./PerformanceModuleHelper.js";
import { ApiModuleHelper } from "./ApiModuleHelper.js";

type IsolatedVMControllerEvents = {}

export interface ControllerCode {
	main: string,
	source: Record<string, string>
}

export interface ControllerOptions {
	apiHelperController?: ApiHelperController,
	inspector?: boolean;
	memoryLimitMb?: number;
	rpcController?: RPCController;
	playerController?: PlayerController;
	config?: {};
}

const defaultExtensions = ["js", "mjs", "json", "json5"];

export class IsolatedVMController extends TypedEventEmitter<IsolatedVMControllerEvents> implements Disposable  {
	#room: Room;
	#source: Record<string, string>;
	#program: IsolatedVMProgram;
	readonly #rpcController: RPCController;
	readonly #playerController: PlayerController;
	readonly #apiHelperController: ApiHelperController | undefined;
	readonly #mainModuleName: string;
	readonly #networkApi: ApiHelper | undefined;
	#apiModuleHelper: ApiModuleHelper | undefined;
	#mainModule: ProgramModule | undefined;
	
	constructor(room: Room, code: ControllerCode, options: ControllerOptions = {}) {
		super();
		try {
			this.#room = room;
			this.#source = {...code.source};
			const configJson = JSON.stringify(options.config) ?? "undefined";
			this.#program = new IsolatedVMProgram(this.#getSource, {
				inspector: options.inspector,
				memoryLimitMb: options.memoryLimitMb
			});
			void this.#program.createModule("varhub:config", `export default ${configJson}`, 'js');
			this.#apiHelperController = options.apiHelperController;
			this.#rpcController = options.rpcController ?? new RPCController(room);
			this.#playerController = options.playerController ?? new PlayerController(room);
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
		await this.#program.createModule("varhub:events", eventEmitterSource)
		await new RoomModuleHelper(this.#room, this.#playerController, this.#program, "varhub:room").execute();
		await new PerformanceModuleHelper(this.#program, "varhub:performance").execute();
		this.#apiModuleHelper = new ApiModuleHelper(this.#apiHelperController, this.#program, "varhub:api/");
		await this.#apiModuleHelper.execute();
		this.#rpcController.addHandler(this.#rpcHandler);
	}
	
	async startAsync(): Promise<this> {
		await this.#startModules();
		this.#mainModule = await this.#program.getModule(this.#mainModuleName);
		return this;
	}
	
	createInspectorSession(){
		return this.#program.createInspectorSession();
	}
	
	#rpcHandler = (connection: Connection, methodName: unknown, ...args: unknown[]) => {
		if (typeof methodName !== "string") return;
		const type = this.#mainModule?.getType(methodName);
		if (type === "function") return () => {
			const player = this.#playerController.getPlayerOfConnection(connection);
			const playerId = player ? this.#playerController.getPlayerId(player) : null;
			if (playerId == null) throw new Error(`no player`);
			return this.#mainModule?.callMethod(methodName, {player: playerId, connection: connection.id}, ...args);
		}
	}
	
	#getSource = (moduleName: string) => {
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
	
	[Symbol.dispose](){
		this.#program[Symbol.dispose]();
	}
}
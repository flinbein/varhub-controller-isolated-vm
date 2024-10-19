export default /* language=JavaScript */ `export class EventEmitter {
	#eventMap = {};
    constructor(){
        const emitter = this;
        Object.assign(this, {
			on(eventName, listener){
				let list = emitter.#eventMap[eventName]
				if (!list) list = emitter.#eventMap[eventName] = [];
				list.push({listener, context: this});
				return this;
			},
			once(eventName, listener){
				let list = emitter.#eventMap[eventName]
				if (!list) list = emitter.#eventMap[eventName] = [];
				list.push({listener, context: this, once: true});
				return this;
			},
			off(eventName, listener){
				if (!listener){
					delete emitter.#eventMap[eventName];
					return this;
				}
				let list = emitter.#eventMap[eventName];
				if (!list) return this;
				const index = list.findIndex(item => item.listener === listener);
				if (index !== -1) list.splice(index, 1);
				return this;
			}
		});
	}
	emit(eventName, ...args){
		let list = this.#eventMap[eventName];
		if (!list || list.length === 0) return false;
		for (const {listener, once, context} of list){
			if (once) this.off(eventName, listener);
			listener.apply(context, args);
		}
		return true;
	}
}`;
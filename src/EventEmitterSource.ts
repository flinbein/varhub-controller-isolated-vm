export default /* language=JavaScript */ `export class EventEmitter {
	#eventMap = {};
	on(eventName, listener){
		let list = this.#eventMap[eventName]
		if (!list) list = this.#eventMap[eventName] = [];
		list.push({listener});
		return this;
	}
	once(eventName, listener){
		let list = this.#eventMap[eventName]
		if (!list) list = this.#eventMap[eventName] = [];
		list.push({listener, once: true});
		return this;
	}
	off(eventName, listener){
		if (!listener){
			delete this.#eventMap[eventName];
			return this;
		}
		let list = this.#eventMap[eventName];
		if (!list) return this;
		const index = list.findIndex(item => item.listener === listener);
		if (index !== -1) list.splice(index, 1);
		return this;
	}
	emit(eventName, ...args){
		let list = this.#eventMap[eventName];
		if (!list || list.length === 0) return false;
		for (const {listener, once} of list){
			if (once) this.off(eventName, listener);
			listener.apply(this, args)
		}
		return true;
	}
}`;
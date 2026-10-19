export interface Timed {
	readonly time: number;
}

// binary min-heap on time, so a frame only looks at timers that are actually due
export class TimerHeap<T extends Timed> {
	private readonly items = new Array<T>();

	public size(): number {
		return this.items.size();
	}

	public peek(): T | undefined {
		return this.items[0];
	}

	public push(item: T): void {
		const items = this.items;
		let index = items.size();
		items.push(item);

		while (index > 0) {
			const parent = math.floor((index - 1) / 2);
			if (items[parent].time <= item.time) {
				break;
			}
			items[index] = items[parent];
			index = parent;
		}
		items[index] = item;
	}

	public pop(): T | undefined {
		const items = this.items;
		const top = items[0];
		const last = items.pop();
		const count = items.size();
		if (last === undefined || count === 0) {
			return top;
		}

		let index = 0;
		while (true) {
			const left = index * 2 + 1;
			if (left >= count) {
				break;
			}
			const right = left + 1;
			const child = right < count && items[right].time < items[left].time ? right : left;
			if (items[child].time >= last.time) {
				break;
			}
			items[index] = items[child];
			index = child;
		}
		items[index] = last;
		return top;
	}

	public clear(): void {
		this.items.clear();
	}
}

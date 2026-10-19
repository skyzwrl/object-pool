import { RunService } from "@rbxts/services";
import { TimerHeap } from "./timer-heap";

// grow: hand out a new object anyway, extras past maxSize are destroyed when they come back
// recycle: take back the object that has been out the longest (bullet holes, debris, decals)
export type OverflowPolicy = "grow" | "recycle";

export interface FrameConnection {
	Disconnect(): void;
}

export interface FrameSignal {
	Connect(callback: (deltaTime: number) => void): FrameConnection;
}

export interface PoolOptions<T> {
	create: () => T;
	reset?: (object: T) => void;
	/** used instead of reset when several objects come back at once */
	resetMany?: (objects: readonly T[]) => void;
	destroy?: (object: T) => void;
	/** how many objects the pool keeps, in use or idle. unlimited by default */
	maxSize?: number;
	whenFull?: OverflowPolicy;
	prewarm?: number;
	clock?: () => number;
	frame?: FrameSignal;
}

export interface PoolStats {
	inUse: number;
	available: number;
	created: number;
	destroyed: number;
	recycled: number;
	peakInUse: number;
}

export interface Lease<T> {
	get(): T;
	isActive(): boolean;
	release(): void;
	releaseAfter(seconds: number): void;
}

interface Slot<T> {
	readonly object: T;
	inUse: boolean;
	lease?: Lease<T>;
	timer?: ReleaseTimer<T>;
	older?: Slot<T>;
	newer?: Slot<T>;
}

interface ReleaseTimer<T> {
	readonly time: number;
	readonly slot: Slot<T>;
}

const LEASE_EXPIRED = "lease has expired, its object was released or recycled";

class SlotLease<T extends defined> implements Lease<T> {
	public constructor(
		private readonly pool: Pool<T>,
		private readonly slot: Slot<T>,
	) {}

	public get(): T {
		if (this.slot.lease !== this) {
			error(LEASE_EXPIRED, 2);
		}
		return this.slot.object;
	}

	public isActive(): boolean {
		return this.slot.lease === this;
	}

	public release(): void {
		if (this.slot.lease !== this) {
			error(LEASE_EXPIRED, 2);
		}
		this.pool.release(this.slot.object);
	}

	public releaseAfter(seconds: number): void {
		if (this.slot.lease !== this) {
			error(LEASE_EXPIRED, 2);
		}
		this.pool.releaseAfter(this.slot.object, seconds);
	}
}

export class Pool<T extends defined> {
	private readonly createObject: () => T;
	private readonly resetObject?: (object: T) => void;
	private readonly resetObjects?: (objects: readonly T[]) => void;
	private readonly destroyObject?: (object: T) => void;
	private readonly maxSize: number;
	private readonly whenFull: OverflowPolicy;
	private readonly clock: () => number;
	private readonly frame: FrameSignal;

	private readonly slots = new Map<T, Slot<T>>();
	private readonly available = new Array<Slot<T>>();
	private readonly timers = new TimerHeap<ReleaseTimer<T>>();
	private readonly expired = new Array<T>();
	private readonly single = new Array<T>();
	private readonly releasing = new Set<T>();
	// checked out slots form a list from oldest to newest so recycling is O(1)
	private oldest?: Slot<T>;
	private newest?: Slot<T>;
	private connection?: FrameConnection;
	private destroyed = false;

	private inUse = 0;
	private created = 0;
	private removed = 0;
	private recycled = 0;
	private peakInUse = 0;

	public constructor(options: PoolOptions<T>) {
		const maxSize = options.maxSize ?? math.huge;
		if (!(maxSize >= 1)) {
			error(`maxSize must be at least 1, got ${maxSize}`, 3);
		}

		this.createObject = options.create;
		this.resetObject = options.reset;
		this.resetObjects = options.resetMany;
		this.destroyObject = options.destroy;
		this.maxSize = maxSize;
		this.whenFull = options.whenFull ?? "grow";
		this.clock = options.clock ?? os.clock;
		this.frame = options.frame ?? RunService.Heartbeat;

		if (options.prewarm !== undefined) {
			this.prewarm(options.prewarm);
		}
	}

	public acquire(): T {
		return this.checkOut().object;
	}

	// a lease errors when used after its object went back, which catches stale references in
	// delayed callbacks that would otherwise poke at an object someone else is now using
	public lease(): Lease<T> {
		const slot = this.checkOut();
		const lease = new SlotLease(this, slot);
		slot.lease = lease;
		return lease;
	}

	public release(object: T): void {
		const slot = this.slotInUse(object);
		this.resetOne(object);
		this.checkIn(slot);
		this.store(slot);
	}

	public releaseMany(objects: readonly T[]): void {
		// validate everything first so a bad entry can't leave the batch half released
		const releasing = this.releasing;
		for (const object of objects) {
			const slot = this.slots.get(object);
			if (slot === undefined || !slot.inUse || releasing.has(object)) {
				releasing.clear();
				error(
					slot === undefined
						? `${tostring(object)} doesn't belong to this pool`
						: `${tostring(object)} is listed twice or was already released`,
					2,
				);
			}
			releasing.add(object);
		}
		releasing.clear();

		if (this.resetObjects !== undefined) {
			this.resetObjects(objects);
		} else if (this.resetObject !== undefined) {
			for (const object of objects) {
				this.resetObject(object);
			}
		}

		for (const object of objects) {
			const slot = this.slots.get(object)!;
			this.checkIn(slot);
			this.store(slot);
		}
	}

	public releaseAfter(object: T, seconds: number): void {
		const slot = this.slotInUse(object);
		if (!(seconds >= 0)) {
			error(`release delay must be a number >= 0, got ${seconds}`, 2);
		}

		const timer: ReleaseTimer<T> = { time: this.clock() + seconds, slot };
		// replacing slot.timer is what cancels an earlier schedule, the old heap entry is skipped when it comes up
		slot.timer = timer;
		this.timers.push(timer);

		if (this.connection === undefined) {
			this.connection = this.frame.Connect(() => this.releaseExpired());
		}
	}

	public cancelRelease(object: T): boolean {
		const slot = this.slots.get(object);
		if (slot === undefined || slot.timer === undefined) {
			return false;
		}
		slot.timer = undefined;
		return true;
	}

	public releaseExpired(now = this.clock()): void {
		const timers = this.timers;
		const expired = this.expired;

		let timer = timers.peek();
		while (timer !== undefined && timer.time <= now) {
			timers.pop();
			if (timer.slot.timer === timer) {
				expired.push(timer.slot.object);
			}
			timer = timers.peek();
		}

		if (!expired.isEmpty()) {
			try {
				this.releaseMany(expired);
			} finally {
				expired.clear();
			}
		}

		if (timers.size() === 0 && this.connection !== undefined) {
			this.connection.Disconnect();
			this.connection = undefined;
		}
	}

	public prewarm(count: number): void {
		const room = this.maxSize - (this.created - this.removed);
		const missing = math.min(count - this.available.size(), room);
		for (let index = 0; index < missing; index++) {
			this.available.push(this.createSlot());
		}
	}

	public owns(object: T): boolean {
		return this.slots.has(object);
	}

	public isInUse(object: T): boolean {
		return this.slots.get(object)?.inUse === true;
	}

	public getStats(): PoolStats {
		return {
			inUse: this.inUse,
			available: this.available.size(),
			created: this.created,
			destroyed: this.removed,
			recycled: this.recycled,
			peakInUse: this.peakInUse,
		};
	}

	// destroys idle objects, anything checked out is left alone
	public clear(): void {
		for (const slot of this.available) {
			this.remove(slot);
		}
		this.available.clear();
	}

	public destroy(): void {
		if (this.destroyed) {
			return;
		}
		this.destroyed = true;
		this.clear();

		let slot = this.oldest;
		while (slot !== undefined) {
			const newer = slot.newer;
			this.checkIn(slot);
			this.remove(slot);
			slot = newer;
		}

		this.timers.clear();
		this.connection?.Disconnect();
		this.connection = undefined;
	}

	private checkOut(): Slot<T> {
		if (this.destroyed) {
			error("this pool was destroyed", 3);
		}

		let slot = this.available.pop();
		if (slot === undefined) {
			const oldest = this.oldest;
			if (oldest !== undefined && this.whenFull === "recycle" && this.created - this.removed >= this.maxSize) {
				this.resetOne(oldest.object);
				this.checkIn(oldest);
				this.recycled += 1;
				slot = oldest;
			} else {
				slot = this.createSlot();
			}
		}

		slot.inUse = true;
		slot.older = this.newest;
		if (this.newest !== undefined) {
			this.newest.newer = slot;
		} else {
			this.oldest = slot;
		}
		this.newest = slot;

		this.inUse += 1;
		this.peakInUse = math.max(this.peakInUse, this.inUse);
		return slot;
	}

	private checkIn(slot: Slot<T>): void {
		slot.inUse = false;
		slot.lease = undefined;
		slot.timer = undefined;

		const { older, newer } = slot;
		if (older !== undefined) {
			older.newer = newer;
		} else {
			this.oldest = newer;
		}
		if (newer !== undefined) {
			newer.older = older;
		} else {
			this.newest = older;
		}
		slot.older = undefined;
		slot.newer = undefined;

		this.inUse -= 1;
	}

	private store(slot: Slot<T>): void {
		if (this.created - this.removed > this.maxSize) {
			this.remove(slot);
		} else {
			this.available.push(slot);
		}
	}

	private createSlot(): Slot<T> {
		const object = this.createObject();
		if (this.slots.has(object)) {
			error(`create returned ${tostring(object)}, which this pool already owns`, 4);
		}
		const slot: Slot<T> = { object, inUse: false };
		this.slots.set(object, slot);
		this.created += 1;
		return slot;
	}

	private remove(slot: Slot<T>): void {
		this.slots.delete(slot.object);
		this.removed += 1;
		this.destroyObject?.(slot.object);
	}

	private resetOne(object: T): void {
		if (this.resetObject !== undefined) {
			this.resetObject(object);
		} else if (this.resetObjects !== undefined) {
			this.single[0] = object;
			this.resetObjects(this.single);
		}
	}

	private slotInUse(object: T): Slot<T> {
		const slot = this.slots.get(object);
		if (slot === undefined) {
			error(`${tostring(object)} doesn't belong to this pool`, 3);
		} else if (!slot.inUse) {
			error(`${tostring(object)} was already released`, 3);
		}
		return slot;
	}
}

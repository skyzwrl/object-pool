/// <reference types="@rbxts/testez/globals" />

import { Pool, PoolOptions } from "..";
import { ManualFrame } from "./manual-frame";

interface Debris {
	id: number;
}

function debris(options: Partial<PoolOptions<Debris>> = {}) {
	const clock = { now: 0 };
	const frame = new ManualFrame();
	const released = new Array<number>();
	let nextId = 0;
	const pool = new Pool<Debris>({
		create: () => {
			nextId += 1;
			return { id: nextId };
		},
		reset: (piece) => released.push(piece.id),
		clock: () => clock.now,
		frame,
		...options,
	});
	return { pool, clock, frame, released };
}

// park-miller, small enough to stay exact in a double
function lcg(seed: number) {
	let state = seed;
	return () => {
		state = (state * 16807) % 2147483647;
		return state / 2147483647;
	};
}

export = () => {
	it("returns objects once their time is up", () => {
		const { pool, clock, frame } = debris();
		const piece = pool.acquire();

		pool.releaseAfter(piece, 2);
		clock.now = 1.99;
		frame.step();
		expect(pool.isInUse(piece)).to.equal(true);

		clock.now = 2;
		frame.step();
		expect(pool.isInUse(piece)).to.equal(false);
		expect(pool.getStats().available).to.equal(1);
	});

	it("only listens to the frame signal while something is scheduled", () => {
		const { pool, clock, frame } = debris();
		const piece = pool.acquire();
		expect(frame.connections).to.equal(0);

		pool.releaseAfter(piece, 1);
		pool.releaseAfter(pool.acquire(), 3);
		expect(frame.connections).to.equal(1);

		clock.now = 1;
		frame.step();
		expect(frame.connections).to.equal(1);

		clock.now = 3;
		frame.step();
		expect(frame.connections).to.equal(0);
	});

	it("ignores the timer when the object was released early and handed out again", () => {
		const { pool, clock, frame } = debris();
		const piece = pool.acquire();
		pool.releaseAfter(piece, 1);
		pool.release(piece);

		const again = pool.acquire();
		clock.now = 5;
		frame.step();

		expect(again).to.equal(piece);
		expect(pool.isInUse(piece)).to.equal(true);
	});

	it("lets a later schedule replace an earlier one", () => {
		const { pool, clock, frame } = debris();
		const piece = pool.acquire();

		pool.releaseAfter(piece, 1);
		pool.releaseAfter(piece, 5);
		clock.now = 2;
		frame.step();
		expect(pool.isInUse(piece)).to.equal(true);

		clock.now = 5;
		frame.step();
		expect(pool.isInUse(piece)).to.equal(false);
	});

	it("cancels a scheduled release", () => {
		const { pool, clock, frame } = debris();
		const piece = pool.acquire();
		pool.releaseAfter(piece, 1);

		expect(pool.cancelRelease(piece)).to.equal(true);
		expect(pool.cancelRelease(piece)).to.equal(false);

		clock.now = 10;
		frame.step();
		expect(pool.isInUse(piece)).to.equal(true);
		expect(frame.connections).to.equal(0);
	});

	it("releases in time order whatever order things were scheduled in", () => {
		const { pool, clock, released } = debris();
		const random = lcg(42);
		const due = new Map<number, number>();

		for (let index = 0; index < 64; index++) {
			const piece = pool.acquire();
			const delay = math.floor(random() * 1000) / 100;
			due.set(piece.id, delay);
			pool.releaseAfter(piece, delay);
		}

		for (let step = 1; step <= 4; step++) {
			clock.now = step * 2.5;
			pool.releaseExpired();
		}

		expect(released.size()).to.equal(64);
		for (let index = 1; index < released.size(); index++) {
			expect(due.get(released[index - 1])! <= due.get(released[index])!).to.equal(true);
		}
	});

	it("hands everything due in the same frame to resetMany together", () => {
		const batches = new Array<number>();
		const { pool, clock, frame } = debris({ resetMany: (objects) => batches.push(objects.size()) });

		pool.releaseAfter(pool.acquire(), 1);
		pool.releaseAfter(pool.acquire(), 1);
		pool.releaseAfter(pool.acquire(), 1.5);
		pool.releaseAfter(pool.acquire(), 4);

		clock.now = 2;
		frame.step();
		clock.now = 4;
		frame.step();

		expect(batches.join(",")).to.equal("3,1");
	});

	it("rejects negative and NaN delays", () => {
		const { pool } = debris();
		const piece = pool.acquire();

		expect(() => pool.releaseAfter(piece, -1)).to.throw("release delay");
		expect(() => pool.releaseAfter(piece, 0 / 0)).to.throw("release delay");
	});

	it("drops pending timers on destroy", () => {
		const { pool, clock, frame } = debris();
		pool.releaseAfter(pool.acquire(), 1);

		pool.destroy();
		clock.now = 2;
		frame.step();

		expect(frame.connections).to.equal(0);
	});
};

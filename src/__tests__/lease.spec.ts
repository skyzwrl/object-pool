/// <reference types="@rbxts/testez/globals" />

import { Pool, PoolOptions } from "..";
import { ManualFrame } from "./manual-frame";

interface Spark {
	lit: boolean;
}

function sparks(options: Partial<PoolOptions<Spark>> = {}) {
	return new Pool<Spark>({
		create: () => ({ lit: false }),
		reset: (spark) => {
			spark.lit = false;
		},
		...options,
	});
}

export = () => {
	it("gives access to its object while active", () => {
		const pool = sparks();
		const lease = pool.lease();

		lease.get().lit = true;

		expect(lease.isActive()).to.equal(true);
		expect(pool.isInUse(lease.get())).to.equal(true);
	});

	it("errors when used after its object went back", () => {
		const pool = sparks();
		const lease = pool.lease();
		lease.release();

		expect(lease.isActive()).to.equal(false);
		expect(() => lease.get()).to.throw("lease has expired");
		expect(() => lease.release()).to.throw("lease has expired");
		expect(() => lease.releaseAfter(1)).to.throw("lease has expired");
	});

	it("expires when its object is released through the pool directly", () => {
		const pool = sparks();
		const lease = pool.lease();

		pool.release(lease.get());

		expect(lease.isActive()).to.equal(false);
	});

	it("can't touch the object once someone else has it", () => {
		const pool = sparks({ maxSize: 1, whenFull: "recycle" });
		const stale = pool.lease();
		const spark = stale.get();

		const current = pool.acquire();

		expect(current).to.equal(spark);
		expect(stale.isActive()).to.equal(false);
		expect(() => stale.release()).to.throw("lease has expired");
		expect(pool.isInUse(current)).to.equal(true);
	});

	it("expires when the object is released and taken again", () => {
		const pool = sparks();
		const stale = pool.lease();
		const spark = stale.get();
		pool.release(spark);

		const fresh = pool.lease();

		expect(fresh.get()).to.equal(spark);
		expect(stale.isActive()).to.equal(false);
		expect(fresh.isActive()).to.equal(true);
	});

	it("schedules its own release", () => {
		let now = 0;
		const frame = new ManualFrame();
		const pool = sparks({ clock: () => now, frame });
		const lease = pool.lease();

		lease.releaseAfter(0.5);
		now = 0.5;
		frame.step();

		expect(lease.isActive()).to.equal(false);
		expect(pool.getStats().available).to.equal(1);
	});
};

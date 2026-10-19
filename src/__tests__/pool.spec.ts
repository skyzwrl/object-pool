/// <reference types="@rbxts/testez/globals" />

import { Pool, PoolOptions } from "..";

interface Bullet {
	id: number;
	speed: number;
	resets: number;
}

function bullets(options: Partial<PoolOptions<Bullet>> = {}) {
	let nextId = 0;
	const destroyed = new Array<Bullet>();
	const pool = new Pool<Bullet>({
		create: () => {
			nextId += 1;
			return { id: nextId, speed: 0, resets: 0 };
		},
		reset: (bullet) => {
			bullet.speed = 0;
			bullet.resets += 1;
		},
		destroy: (bullet) => destroyed.push(bullet),
		...options,
	});
	return { pool, destroyed };
}

export = () => {
	describe("acquire and release", () => {
		it("creates objects on demand and hands released ones back out", () => {
			const { pool } = bullets();

			const first = pool.acquire();
			const second = pool.acquire();
			expect(first).never.to.equal(second);

			pool.release(first);
			expect(pool.acquire()).to.equal(first);
			expect(pool.getStats().created).to.equal(2);
		});

		it("resets objects when they come back, not when they go out", () => {
			const { pool } = bullets();

			const bullet = pool.acquire();
			bullet.speed = 50;
			expect(bullet.resets).to.equal(0);

			pool.release(bullet);
			expect(bullet.speed).to.equal(0);
			expect(bullet.resets).to.equal(1);

			pool.acquire();
			expect(bullet.resets).to.equal(1);
		});

		it("rejects releasing an object twice", () => {
			const { pool } = bullets();
			const bullet = pool.acquire();
			pool.release(bullet);

			expect(() => pool.release(bullet)).to.throw("was already released");
		});

		it("rejects objects it never created", () => {
			const { pool } = bullets();

			expect(() => pool.release({ id: -1, speed: 0, resets: 0 })).to.throw("doesn't belong to this pool");
		});

		it("keeps the object checked out when reset throws", () => {
			const { pool } = bullets({
				reset: () => {
					throw "reset failed";
				},
			});
			const bullet = pool.acquire();

			expect(() => pool.release(bullet)).to.throw("reset failed");
			expect(pool.isInUse(bullet)).to.equal(true);
			expect(pool.getStats().inUse).to.equal(1);
		});

		it("errors when create returns an object it already owns", () => {
			const shared = { id: 1, speed: 0, resets: 0 };
			const pool = new Pool<Bullet>({ create: () => shared });
			pool.acquire();

			expect(() => pool.acquire()).to.throw("already owns");
		});

		it("reports ownership and use", () => {
			const { pool } = bullets();
			const bullet = pool.acquire();

			expect(pool.owns(bullet)).to.equal(true);
			expect(pool.isInUse(bullet)).to.equal(true);
			pool.release(bullet);
			expect(pool.owns(bullet)).to.equal(true);
			expect(pool.isInUse(bullet)).to.equal(false);
		});
	});

	describe("limits", () => {
		it("prewarms idle objects without going past maxSize", () => {
			const { pool } = bullets({ maxSize: 3, prewarm: 5 });
			expect(pool.getStats().available).to.equal(3);
			expect(pool.getStats().created).to.equal(3);

			pool.prewarm(2);
			expect(pool.getStats().created).to.equal(3);

			pool.acquire();
			pool.prewarm(3);
			expect(pool.getStats().available).to.equal(2);
			expect(pool.getStats().created).to.equal(3);
		});

		it("grows past maxSize and destroys the extras as they come back", () => {
			const { pool, destroyed } = bullets({ maxSize: 2 });
			const out = [pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()];
			expect(pool.getStats().created).to.equal(4);

			for (const bullet of out) {
				pool.release(bullet);
			}

			expect(pool.getStats().available).to.equal(2);
			expect(destroyed.size()).to.equal(2);
			expect(pool.owns(destroyed[0])).to.equal(false);
		});

		it("recycles the object that has been out the longest", () => {
			const { pool } = bullets({ maxSize: 2, whenFull: "recycle" });
			const first = pool.acquire();
			const second = pool.acquire();
			first.speed = 10;

			const third = pool.acquire();

			expect(third).to.equal(first);
			expect(third.speed).to.equal(0);
			expect(third.resets).to.equal(1);
			expect(pool.getStats().created).to.equal(2);
			expect(pool.getStats().recycled).to.equal(1);
			expect(pool.isInUse(second)).to.equal(true);
		});

		it("recycles in checkout order", () => {
			const { pool } = bullets({ maxSize: 3, whenFull: "recycle" });
			const a = pool.acquire();
			const b = pool.acquire();
			const c = pool.acquire();

			pool.release(b);
			const reused = pool.acquire();
			expect(reused).to.equal(b);

			expect(pool.acquire()).to.equal(a);
			expect(pool.acquire()).to.equal(c);
			expect(pool.acquire()).to.equal(b);
		});

		it("rejects a maxSize below 1", () => {
			expect(() => new Pool({ create: () => ({}), maxSize: 0 })).to.throw("maxSize must be at least 1");
		});
	});

	describe("stats", () => {
		it("tracks use, creation, destruction, recycling and the peak", () => {
			const { pool } = bullets({ maxSize: 2, whenFull: "recycle", prewarm: 1 });

			const a = pool.acquire();
			const b = pool.acquire();
			pool.acquire();
			pool.release(b);

			const stats = pool.getStats();
			expect(stats.inUse).to.equal(1);
			expect(stats.available).to.equal(1);
			expect(stats.created).to.equal(2);
			expect(stats.destroyed).to.equal(0);
			expect(stats.recycled).to.equal(1);
			expect(stats.peakInUse).to.equal(2);
			expect(pool.isInUse(a)).to.equal(true);
		});
	});

	describe("clear and destroy", () => {
		it("clear destroys idle objects and leaves checked out ones alone", () => {
			const { pool, destroyed } = bullets({ prewarm: 3 });
			const out = pool.acquire();

			pool.clear();

			expect(destroyed.size()).to.equal(2);
			expect(pool.getStats().available).to.equal(0);
			expect(pool.isInUse(out)).to.equal(true);
			pool.release(out);
			expect(pool.getStats().available).to.equal(1);
		});

		it("destroy takes everything down and refuses further use", () => {
			const { pool, destroyed } = bullets({ prewarm: 2 });
			pool.acquire();
			pool.acquire();
			pool.acquire();

			pool.destroy();
			pool.destroy();

			expect(destroyed.size()).to.equal(3);
			expect(pool.getStats().inUse).to.equal(0);
			expect(() => pool.acquire()).to.throw("this pool was destroyed");
		});
	});

	describe("releaseMany", () => {
		it("hands the whole batch to resetMany in one call", () => {
			const batches = new Array<number>();
			const { pool } = bullets({ resetMany: (objects) => batches.push(objects.size()) });
			const out = [pool.acquire(), pool.acquire(), pool.acquire()];

			pool.releaseMany(out);

			expect(batches.join(",")).to.equal("3");
			expect(pool.getStats().available).to.equal(3);
		});

		it("falls back to reset per object", () => {
			const { pool } = bullets();
			const out = [pool.acquire(), pool.acquire()];

			pool.releaseMany(out);

			expect(out[0].resets).to.equal(1);
			expect(out[1].resets).to.equal(1);
		});

		it("releases nothing when any entry is invalid", () => {
			const { pool } = bullets();
			const a = pool.acquire();
			const b = pool.acquire();

			expect(() => pool.releaseMany([a, { id: -1, speed: 0, resets: 0 }, b])).to.throw(
				"doesn't belong to this pool",
			);
			expect(pool.isInUse(a)).to.equal(true);
			expect(pool.isInUse(b)).to.equal(true);
			expect(a.resets).to.equal(0);
		});

		it("rejects an object listed twice", () => {
			const { pool } = bullets();
			const a = pool.acquire();

			expect(() => pool.releaseMany([a, a])).to.throw("listed twice");
			expect(pool.isInUse(a)).to.equal(true);
		});

		it("uses resetMany for single releases when there is no reset", () => {
			const seen = new Array<number>();
			const pool = new Pool<Bullet>({
				create: () => ({ id: 7, speed: 0, resets: 0 }),
				resetMany: (objects) => {
					for (const object of objects) {
						seen.push(object.id);
					}
				},
			});

			pool.release(pool.acquire());

			expect(seen.join(",")).to.equal("7");
		});
	});
};

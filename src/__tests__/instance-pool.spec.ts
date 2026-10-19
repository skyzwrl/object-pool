/// <reference types="@rbxts/testez/globals" />

import { Workspace } from "@rbxts/services";
import { InstancePool, InstancePoolOptions } from "..";
import { ManualFrame } from "./manual-frame";

const PARK = new CFrame(0, 1e7, 0);

function makeTemplate(): Part {
	const template = new Instance("Part");
	template.Name = "Spark";
	template.Anchored = true;
	template.CanCollide = false;
	template.Transparency = 0.2;
	template.Color = Color3.fromRGB(255, 170, 0);
	template.Size = new Vector3(0.4, 0.4, 0.4);
	template.Material = Enum.Material.Neon;
	return template;
}

function makeContainer(): Folder {
	const folder = new Instance("Folder");
	folder.Name = "Effects";
	folder.Parent = Workspace;
	return folder;
}

interface BulkCall {
	parts: number;
	cframes: number;
	height: number;
}

function recordBulkMoves(calls: BulkCall[]): InstancePoolOptions<Part>["bulkMove"] {
	return (parts, cframes) => {
		calls.push({ parts: parts.size(), cframes: cframes.size(), height: cframes[0].Position.Y });
		for (let index = 0; index < parts.size(); index++) {
			parts[index].CFrame = cframes[index];
		}
	};
}

export = () => {
	it("clones the template into the container and parks the clones", () => {
		const container = makeContainer();
		const template = makeTemplate();
		new InstancePool(template, { parent: container, prewarm: 3 });

		const children = container.GetChildren();
		expect(children.size()).to.equal(3);
		for (const child of children) {
			expect(child.Name).to.equal("Spark");
			expect((child as Part).CFrame.Position.Y).to.be.near(PARK.Position.Y, 1);
		}
		expect(template.Parent).never.to.be.ok();
	});

	it("parks released parts instead of reparenting them", () => {
		const container = makeContainer();
		const pool = new InstancePool(makeTemplate(), { parent: container });

		const spark = pool.acquire();
		spark.CFrame = new CFrame(10, 5, -3);
		pool.release(spark);

		expect(spark.Parent).to.equal(container);
		expect(spark.CFrame.Position.Y).to.be.near(PARK.Position.Y, 1);
	});

	it("puts changed properties back to the template's", () => {
		const template = makeTemplate();
		const pool = new InstancePool(template, { parent: makeContainer() });
		const spark = pool.acquire();

		spark.Transparency = 1;
		spark.Color = new Color3(0, 0, 1);
		spark.Size = new Vector3(3, 3, 3);
		spark.Material = Enum.Material.Plastic;
		spark.Anchored = false;
		spark.CanCollide = true;
		spark.CanQuery = false;
		spark.AssemblyLinearVelocity = new Vector3(0, 80, 0);
		pool.release(spark);

		expect(spark.Transparency).to.be.near(0.2, 1e-4);
		expect(spark.Color).to.equal(template.Color);
		expect(spark.Size).to.equal(template.Size);
		expect(spark.Material).to.equal(Enum.Material.Neon);
		expect(spark.Anchored).to.equal(true);
		expect(spark.CanCollide).to.equal(false);
		expect(spark.CanQuery).to.equal(true);
		expect(spark.AssemblyLinearVelocity.Magnitude).to.equal(0);
	});

	it("leaves properties alone when asked to", () => {
		const pool = new InstancePool(makeTemplate(), { parent: makeContainer(), restoreProperties: false });
		const spark = pool.acquire();

		spark.Transparency = 1;
		pool.release(spark);

		expect(spark.Transparency).to.equal(1);
		expect(spark.CFrame.Position.Y).to.be.near(PARK.Position.Y, 1);
	});

	it("runs the extra reset before parking", () => {
		let heightAtReset = -1;
		const pool = new InstancePool(makeTemplate(), {
			parent: makeContainer(),
			reset: (spark) => {
				heightAtReset = spark.CFrame.Position.Y;
				spark.Name = "Reset";
			},
		});
		const spark = pool.acquire();
		spark.CFrame = new CFrame(0, 12, 0);

		pool.release(spark);

		expect(heightAtReset).to.be.near(12, 1e-4);
		expect(spark.Name).to.equal("Reset");
	});

	it("parks a batch with one bulk move", () => {
		const calls = new Array<BulkCall>();
		const pool = new InstancePool(makeTemplate(), {
			parent: makeContainer(),
			bulkMove: recordBulkMoves(calls),
		});
		const sparks = [pool.acquire(), pool.acquire(), pool.acquire()];
		for (const spark of sparks) {
			spark.CFrame = new CFrame(0, 3, 0);
			spark.Transparency = 1;
		}

		pool.releaseMany(sparks);

		expect(calls.size()).to.equal(1);
		expect(calls[0].parts).to.equal(3);
		expect(calls[0].cframes).to.equal(3);
		expect(calls[0].height).to.be.near(PARK.Position.Y, 1);
		expect(sparks[2].Transparency).to.be.near(0.2, 1e-4);
	});

	it("parks everything that expires in the same frame together", () => {
		const calls = new Array<BulkCall>();
		let now = 0;
		const frame = new ManualFrame();
		const pool = new InstancePool(makeTemplate(), {
			parent: makeContainer(),
			bulkMove: recordBulkMoves(calls),
			clock: () => now,
			frame,
		});

		for (let index = 0; index < 4; index++) {
			pool.releaseAfter(pool.acquire(), 0.25);
		}
		now = 0.25;
		frame.step();

		expect(calls.size()).to.equal(1);
		expect(calls[0].parts).to.equal(4);
		expect(pool.getStats().available).to.equal(4);
	});

	it("parks one at a time with a custom move unless a bulk move is given too", () => {
		const moves = new Array<number>();
		const pool = new InstancePool(makeTemplate(), {
			parent: makeContainer(),
			move: (spark, cframe) => {
				moves.push(cframe.Position.Y);
				spark.CFrame = cframe;
			},
		});
		const sparks = [pool.acquire(), pool.acquire()];
		moves.clear();

		pool.releaseMany(sparks);

		expect(moves.size()).to.equal(2);
		expect(moves[0]).to.be.near(PARK.Position.Y, 1);
	});

	it("destroys clones that don't fit back in the pool", () => {
		const container = makeContainer();
		const pool = new InstancePool(makeTemplate(), { parent: container, maxSize: 1 });
		const first = pool.acquire();
		const second = pool.acquire();

		// over the limit, so whichever comes back first is the one that goes
		pool.release(first);
		pool.release(second);

		expect(first.Parent).never.to.be.ok();
		expect(second.Parent).to.equal(container);
		expect(container.GetChildren().size()).to.equal(1);
	});

	it("parks at a custom spot", () => {
		const spot = new CFrame(500, -200, 500);
		const pool = new InstancePool(makeTemplate(), { parent: makeContainer(), parkCFrame: spot });
		const spark = pool.acquire();

		expect(spark.CFrame.Position.X).to.be.near(500, 1e-3);
		pool.release(spark);
		expect(spark.CFrame.Position.Y).to.be.near(-200, 1e-3);
	});

	it("moves models through the move option", () => {
		const template = new Instance("Model");
		template.Name = "Crate";
		new Instance("Part").Parent = template;
		const moved = new Array<Model>();
		const pool = new InstancePool(template, {
			parent: makeContainer(),
			move: (model) => moved.push(model),
		});

		const crate = pool.acquire();
		pool.release(crate);

		expect(crate.GetChildren().size()).to.equal(1);
		expect(moved.size()).to.equal(2);
		expect(moved[1]).to.equal(crate);
	});

	it("refuses templates that can't be cloned", () => {
		const template = makeTemplate();
		template.Archivable = false;

		expect(() => new InstancePool(template, { parent: makeContainer() })).to.throw("isn't Archivable");
	});
};

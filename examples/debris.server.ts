import { ServerStorage, Workspace } from "@rbxts/services";
import { InstancePool } from "@skyzwrl/object-pool";

const folder = new Instance("Folder");
folder.Name = "Debris";
folder.Parent = Workspace;

const chunks = new InstancePool(ServerStorage.WaitForChild("Chunk") as Part, {
	parent: folder,
	prewarm: 50,
	maxSize: 200,
	whenFull: "recycle",
});

const random = new Random();

export function shatter(origin: Vector3, count: number) {
	for (let index = 0; index < count; index++) {
		const lease = chunks.lease();
		const chunk = lease.get();
		chunk.CFrame = new CFrame(origin.add(random.NextUnitVector()));
		chunk.Anchored = false;
		chunk.AssemblyLinearVelocity = random.NextUnitVector().mul(random.NextNumber(30, 60));

		// a big explosion can recycle this chunk before the fade runs, the lease says whether it's still ours
		task.delay(2.5, () => {
			if (lease.isActive()) {
				lease.get().Transparency = 0.5;
			}
		});
		lease.releaseAfter(3);
	}
}

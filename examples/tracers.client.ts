import { InstancePool } from "@skyzwrl/object-pool";

const template = new Instance("Part");
template.Name = "Tracer";
template.Anchored = true;
template.CanCollide = false;
template.CanQuery = false;
template.CanTouch = false;
template.CastShadow = false;
template.Material = Enum.Material.Neon;
template.Color = Color3.fromRGB(255, 220, 120);

// automatic weapons fire a lot of these, recycling the oldest beats growing forever during a firefight
const tracers = new InstancePool(template, { prewarm: 40, maxSize: 120, whenFull: "recycle" });

export function drawTracer(from: Vector3, to: Vector3) {
	const length = to.sub(from).Magnitude;
	const tracer = tracers.acquire();
	tracer.Size = new Vector3(0.08, 0.08, length);
	tracer.CFrame = CFrame.lookAt(from, to).mul(new CFrame(0, 0, -length / 2));
	tracers.releaseAfter(tracer, 0.05);
}

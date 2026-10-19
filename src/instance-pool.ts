import { Workspace } from "@rbxts/services";
import { Pool, PoolOptions } from "./pool";

type Poolable = BasePart | Model;

export interface InstancePoolOptions<T extends Poolable> extends Pick<
	PoolOptions<T>,
	"reset" | "maxSize" | "whenFull" | "prewarm" | "clock" | "frame"
> {
	parent?: Instance;
	parkCFrame?: CFrame;
	/** put Transparency, Color, Size, Material, Anchored and collision flags back to the template's, zero velocity */
	restoreProperties?: boolean;
	move?: (object: T, cframe: CFrame) => void;
	bulkMove?: (parts: BasePart[], cframes: CFrame[]) => void;
}

// anchored parts don't simulate, so far away is enough to hide them, and streaming drops them on clients
const DEFAULT_PARK = new CFrame(0, 1e7, 0);

interface PartDefaults {
	transparency: number;
	color: Color3;
	size: Vector3;
	material: Enum.Material;
	anchored: boolean;
	canCollide: boolean;
	canTouch: boolean;
	canQuery: boolean;
}

function readDefaults(part: BasePart): PartDefaults {
	return {
		transparency: part.Transparency,
		color: part.Color,
		size: part.Size,
		material: part.Material,
		anchored: part.Anchored,
		canCollide: part.CanCollide,
		canTouch: part.CanTouch,
		canQuery: part.CanQuery,
	};
}

function restore(part: BasePart, defaults: PartDefaults): void {
	part.Transparency = defaults.transparency;
	part.Color = defaults.color;
	part.Size = defaults.size;
	part.Material = defaults.material;
	part.Anchored = defaults.anchored;
	part.CanCollide = defaults.canCollide;
	part.CanTouch = defaults.canTouch;
	part.CanQuery = defaults.canQuery;
	// anchored parts keep their velocity (it's how conveyors work), so leftover speed from debris would
	// shove whatever touches the part on its next use
	part.AssemblyLinearVelocity = Vector3.zero;
	part.AssemblyAngularVelocity = Vector3.zero;
}

function moveInstance(object: Poolable, cframe: CFrame): void {
	if (object.IsA("BasePart")) {
		object.CFrame = cframe;
	} else {
		object.PivotTo(cframe);
	}
}

function bulkMoveParts(parts: BasePart[], cframes: CFrame[]): void {
	Workspace.BulkMoveTo(parts, cframes, Enum.BulkMoveMode.FireCFrameChanged);
}

// clones are parented once when created and never again. released objects get parked instead, because a
// Parent change replicates the whole instance to every client and rebuilds its physics and render state,
// while moving an anchored part is a single property update
export class InstancePool<T extends Poolable> extends Pool<T> {
	public constructor(template: T, options: InstancePoolOptions<T> = {}) {
		if (!template.Archivable) {
			error(`${template.GetFullName()} isn't Archivable, Clone would return nothing`, 3);
		}

		const parent = options.parent ?? Workspace;
		const parkCFrame = options.parkCFrame ?? DEFAULT_PARK;
		const move = options.move ?? moveInstance;
		const bulkMove = options.bulkMove ?? (options.move === undefined ? bulkMoveParts : undefined);
		const userReset = options.reset;
		const isPart = template.IsA("BasePart");
		const defaults = isPart && options.restoreProperties !== false ? readDefaults(template) : undefined;

		const prepare = (object: T) => {
			if (defaults !== undefined) {
				restore(object as BasePart, defaults);
			}
			userReset?.(object);
		};

		super({
			create: () => {
				const clone = template.Clone() as T;
				move(clone, parkCFrame);
				clone.Parent = parent;
				return clone;
			},
			reset: (object) => {
				prepare(object);
				move(object, parkCFrame);
			},
			resetMany:
				isPart && bulkMove !== undefined
					? (objects) => {
							for (const object of objects) {
								prepare(object);
							}
							bulkMove(objects as unknown as BasePart[], table.create(objects.size(), parkCFrame));
						}
					: undefined,
			destroy: (object) => object.Destroy(),
			maxSize: options.maxSize,
			whenFull: options.whenFull,
			prewarm: options.prewarm,
			clock: options.clock,
			frame: options.frame,
		});
	}
}

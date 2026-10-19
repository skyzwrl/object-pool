import { FrameConnection, FrameSignal } from "../pool";

class ManualConnection implements FrameConnection {
	public constructor(private readonly frame: ManualFrame) {}

	public Disconnect(): void {
		this.frame.disconnect();
	}
}

export class ManualFrame implements FrameSignal {
	public connections = 0;
	private listener?: (deltaTime: number) => void;

	public Connect(callback: (deltaTime: number) => void): FrameConnection {
		this.listener = callback;
		this.connections += 1;
		return new ManualConnection(this);
	}

	public disconnect(): void {
		this.listener = undefined;
		this.connections -= 1;
	}

	public step(deltaTime = 1 / 60): void {
		this.listener?.(deltaTime);
	}
}

declare class GameQueue {
    constructor();
    start(): void;
    onNextAction(action: any): void;
    tryDequeue(): Promise<void>;
    tryRunGame(room_slug: any): Promise<void>;
}
declare const _default: GameQueue;
export default _default;
//# sourceMappingURL=gamequeue.d.ts.map
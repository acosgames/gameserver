declare class GameTimer {
    constructor();
    setup(): void;
    calculateTimeleft(roomState: any): number;
    processTimelimit(gamestate: any): {
        timeend: number;
        timesec: number;
    };
    processDeadlines(): Promise<void>;
    processDeadlinesEX(next: any): Promise<{}>;
    removeRoomDeadline(room_slug: any): Promise<void>;
    addRoomDeadline(room_slug: any, timeend: any): Promise<void>;
}
declare const _default: GameTimer;
export default _default;
//# sourceMappingURL=gametimer.d.ts.map
import { GameStateReader } from "@acosgames/framework";
declare class GameTimer {
    constructor();
    setup(): void;
    calculateTimeleft(roomState: any): number;
    processTimelimit(game: GameStateReader): {
        timeend: number;
        timesec: number;
    };
    processDeadlines(): Promise<void>;
    processDeadlinesEX(next: any): Promise<any>;
    removeRoomDeadline(room_slug: any): Promise<void>;
    addRoomDeadline(room_slug: any, timeend: any): Promise<void>;
}
declare const _default: GameTimer;
export default _default;
//# sourceMappingURL=gametimer.d.ts.map
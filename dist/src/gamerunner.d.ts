import ivm from "isolated-vm";
declare class GameRunner {
    constructor();
    getIsolate(): ivm.Isolate;
    queueRoomAction(room_slug: any, fn: any): any;
    createScriptGlobals(ctx: any, room_slug: any): {
        gamelog: () => void;
        gameerror: () => void;
        save: ivm.Callback<(newGame: any) => void>;
        random: ivm.Callback<() => any>;
        game: ivm.Callback<() => any>;
        actions: ivm.Callback<() => any>;
        killGame: ivm.Callback<() => void>;
        database: ivm.Callback<() => any>;
        ignore: ivm.Callback<() => void>;
    };
    killRoom(room_slug: any, meta: any, errors?: any[]): Promise<void>;
    runAction(incomingActions: any, gameScript: any, meta: any): Promise<any>;
    runActionInternal(incomingActions: any, gameScript: any, meta: any): Promise<boolean>;
    runActionEx(action: any, gameScript: any, meta: any, ctx: any): Promise<false | {
        type: string;
        isGameover: boolean;
    }>;
    validateGlobalResult(result: any): boolean;
    executeScript(gameScript: any, action: any, meta: any, ctx: any): Promise<boolean>;
    addEvent(type: any, payload: any, ctx: any): void;
    onLeave(action: any, ctx: any): void;
    onJoin(room_slug: any, action: any, ctx: any): void;
    onReady(meta: any, ctx: any): void;
    onGameover(meta: any, ctx: any): Promise<void>;
    runScript(script: any, room_slug: any, ctx: any): boolean;
    onPlayerReady(action: any, ctx: any): void;
    onPlayerJoin(action: any, ctx: any): void;
}
declare const _default: GameRunner;
export default _default;
//# sourceMappingURL=gamerunner.d.ts.map
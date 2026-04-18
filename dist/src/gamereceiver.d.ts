declare class GameReceiver {
    constructor();
    sleep(ms: any): Promise<unknown>;
    start(): Promise<unknown>;
    onDecomission(msg: any): Promise<void>;
    onHealthCheck(msg: any): Promise<void>;
    onSkip(msg: any): Promise<void>;
    onGameStart(msg: any): Promise<void>;
    onLoadGame(msg: any): Promise<boolean>;
    onNextAction(actions: any): Promise<boolean>;
    createGameReceiver(key: any, initialActions: any): Promise<boolean>;
}
declare const _default: GameReceiver;
export default _default;
//# sourceMappingURL=gamereceiver.d.ts.map
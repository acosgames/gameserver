declare class Events {
    constructor();
    addNextActionListener(func: any): void;
    emitNextAction(payload: any): void;
    addLoadGameListener(func: any): void;
    emitLoadGame(payload: any): void;
    addSkipListener(func: any): void;
    emitSkip(payload: any): void;
    addGameStartListener(func: any): void;
    emitGameStart(payload: any): void;
}
declare const _default: Events;
export default _default;
//# sourceMappingURL=events.d.ts.map
declare class Storage {
    constructor();
    clearRooms(): void;
    addRoom(r: any): void;
    getRooms(): any;
    setQueueKey(q: any): void;
    getQueueKey(): any;
    addError(game_slug: any, version: any, error: any): Promise<any>;
    getLastActionRunSeconds(): number;
    calculateActionRate(): number;
    processActionRate(): void;
    incrementRoomCount(): void;
    decrementRoomCount(): void;
    getGameServers(): any;
    getGameServer(id: any): any;
    setGameServer(id: any, game: any): void;
    isLoaded(game_slug: any): any;
    setLoaded(game_slug: any, isloaded: any): void;
    getGameDatabases(): any;
    getGameDatabase(id: any): any;
    setGameDatabase(id: any, db: any): void;
    getRoomMeta(room_slug: any): Promise<import("shared/types/room.js").RoomMeta>;
    getRoomState(room_slug: any): Promise<unknown>;
    saveRoomState(type: any, meta: any, roomState: any): Promise<void>;
    cleanupRoom(meta: any): Promise<void>;
    getTimerData(room_slug: any): Promise<unknown>;
    getNextTimer(gameserver_slug: any): Promise<false | {
        value: any;
        score: any;
    }>;
    addTimer(room_slug: any, epoch: any): Promise<any>;
    removeTimer(room_slug: any): Promise<any>;
    setRoomDeadline(room_slug: any, data: any): Promise<void>;
    clearRoomDeadline(room_slug: any): Promise<void>;
    makeGame(meta: any): {};
}
declare const _default: Storage;
export default _default;
//# sourceMappingURL=storage.d.ts.map
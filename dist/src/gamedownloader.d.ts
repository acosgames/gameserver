declare class GameDownloader {
    downloadServerFiles(action: any, meta: any, isolate: any): Promise<void>;
    downloadGameJS(key: any, meta: any, isolate: any): Promise<{
        script: any;
    }>;
    downloadPublicJson(key: any, meta: any): Promise<any>;
    downloadGameDatabase(key: any, meta: any): Promise<{
        db: any;
    }>;
}
declare const _default: GameDownloader;
export default _default;
//# sourceMappingURL=gamedownloader.d.ts.map
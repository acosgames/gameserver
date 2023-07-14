const ObjectStorageService = require("shared/services/objectstorage");
const s3 = new ObjectStorageService();
const storage = require('./storage');
// const { VMScript } = require('vm2');
const profiler = require('shared/util/profiler');
class GameDownloader {

    async downloadServerFiles(action, meta, isolate) {
        let room_slug = action.room_slug;

        profiler.StartTime("downloadServerFiles.getRoomMeta");
        meta = meta || await storage.getRoomMeta(room_slug);
        profiler.EndTime("downloadServerFiles.getRoomMeta");

        profiler.StartTime("downloadServerFiles.downloadGameJS");
        try {
            let key = meta.game_slug + '/server.bundle.' + meta.version + '.js';

            let gameServer = storage.getGameServer(key);

            console.log("typeof tsupdate: ", typeof gameServer?.lastupdate, typeof meta?.latest_tsupdate);
            if (!gameServer || gameServer.lastupdate !== meta.latest_tsupdate) {
                gameServer = await this.downloadGameJS(key, meta, isolate);
                gameServer.lastupdate = meta.latest_tsupdate;
                if (!gameServer || !gameServer.script) {
                    console.error("Script unable to be created for: ", action);
                }
                storage.setGameServer(key, gameServer);
            }
        } catch (e) {
            console.error("Error: Script unable to be created for: ", action);
            console.log('Error:', e);
        }
        profiler.EndTime("downloadServerFiles.downloadGameJS");


        if (!meta.db)
            return;

        profiler.StartTime("downloadServerFiles.downloadDatabase");
        try {
            let key = meta.game_slug + '/server.db.' + meta.version + '.json';
            let gameDatabase = storage.getGameDatabase(key);
            if (!gameDatabase || gameDatabase.lastupdate !== meta.latest_tsupdate) {
                gameDatabase = await this.downloadGameDatabase(key, meta);
                gameDatabase.lastupdate = meta.latest_tsupdate;
                if (!gameDatabase) {
                    console.error("Database unable to be created for: ", action);
                }
                storage.setGameDatabase(key, gameDatabase);
            }
        } catch (e) {
            console.error("Error: Database unable to be created for: ", action);
            console.log('Error:', e);
        }
        profiler.EndTime("downloadServerFiles.downloadDatabase");
    }

    async downloadGameJS(key, meta, isolate) {
        const js = await s3.downloadServerScript(key, meta);
        // var script = new VMScript(js);

        const script = isolate.compileScriptSync(js);

        const game = { script };
        //storage.setGameServer(key, game);
        return game;
    }

    async downloadGameDatabase(key, meta) {
        var json = await s3.downloadServerScript(key, meta);
        let db = { db: JSON.parse(json) };
        //storage.setGameDatabase(key, db);
        return db;
    }
}

module.exports = new GameDownloader();
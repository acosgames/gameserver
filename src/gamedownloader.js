const ObjectStorageService = require("fsg-shared/services/objectstorage");
const s3 = new ObjectStorageService();
const storage = require('./storage');
const { VMScript } = require('vm2');

class GameDownloader {

    async downloadServerFiles(action, meta) {
        let room_slug = action.room_slug;

        meta = meta || await storage.getRoomMeta(room_slug);

        try {
            let key = meta.gameid + '/server.bundle.' + meta.version + '.js';
            let gameServer = storage.getGameServer(key);

            if (!gameServer || gameServer.lastupdate != meta.latest_tsupdate) {
                gameServer = await this.downloadGameJS(key, meta);
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

        if (!meta.db)
            return;

        try {
            let key = meta.gameid + '/server.db.' + meta.version + '.json';
            let gameDatabase = storage.getGameDatabase(key);
            if (!gameDatabase || gameDatabase.lastupdate != meta.latest_tsupdate) {
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
    }

    async downloadGameJS(key, meta) {
        var js = await s3.downloadServerScript(key, meta);
        var script = new VMScript(js);
        let game = { script };
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
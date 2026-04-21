import ObjectStorageService from "shared/services/objectstorage.js";
import storage from "./storage.js";
// const { VMScript } = require('vm2');
import profiler from "shared/util/profiler.js";
import { GameSettings } from "shared/types/game.js";

const s3 = new ObjectStorageService();

class GameDownloader {

    async downloadServerFiles(action, meta, isolate) {
        let room_slug = action.room_slug;

        // profiler.StartTime("downloadServerFiles.getRoomMeta");
        meta = meta || await storage.getRoomMeta(room_slug);
        // profiler.EndTime("downloadServerFiles.getRoomMeta");

        // profiler.StartTime("downloadServerFiles.downloadGameJS"); 
        try {
            let key = meta.game_slug + '/server.bundle.' + meta.version + '.js';

            let gameServer = storage.getGameServer(key);

            console.log("typeof tsupdate: ", typeof gameServer?.lastupdate, typeof meta?.latest_tsupdate);
            // if (!gameServer || gameServer.lastupdate !== meta.latest_tsupdate) {
                gameServer = await this.downloadGameJS(key, meta, isolate);
                gameServer.lastupdate = meta.latest_tsupdate;
                if (!gameServer || !gameServer.script) {
                    console.error("Script unable to be created for: ", action);
                }
                storage.setGameServer(key, gameServer);
            // }
        } catch (e) {
            console.error("Error: Script unable to be created for: ", action);
            console.log('Error:', e);
        }
        // profiler.EndTime("downloadServerFiles.downloadGameJS");


        if (meta.settings) {
            try {
                let key = "g/" + meta.game_slug + '/client/settings.' + meta.version + '.json';
                let gameSettings: GameSettings = await storage.getGameSetting(key);
                if (!gameSettings || gameSettings.lastupdate !== meta.latest_tsupdate) {
                    gameSettings = await this.downloadPublicJson(key, meta) as GameSettings;
                    gameSettings.lastupdate = meta.latest_tsupdate;
                    if (!gameSettings) {
                        console.error("Database unable to be created for: ", action);
                    }
                    storage.setGameSetting(key, gameSettings);
                }
            } catch (e) {
                console.error("Error: Database unable to be created for: ", action);
                console.log('Error:', e);
            }
        }

        if (meta.db) {
            // profiler.StartTime("downloadServerFiles.downloadDatabase");
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
            // profiler.EndTime("downloadServerFiles.downloadDatabase");
        }
    }

    async downloadGameJS(key, meta, isolate) {
        const js = await s3.downloadServerScript(key, meta);
        // var script = new VMScript(js);

        const script = isolate.compileScriptSync(js);

        const game = { script };
        //storage.setGameServer(key, game);
        return game;
    }

    async downloadPublicJson(key, meta) {
        const jsStr = await s3.downloadPublicScript(key, meta);
        const json = JSON.parse(jsStr);
        return json;
    }

    async downloadGameDatabase(key, meta) {
        var json = await s3.downloadServerScript(key, meta);
        let db = { db: JSON.parse(json) };
        //storage.setGameDatabase(key, db);
        return db;
    }
}

export default new GameDownloader(); 
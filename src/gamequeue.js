var Queue = require('queue-fifo');

const events = require('./events');
const storage = require('./storage');

const gamedownloader = require('./gamedownloader');
const gamerunner = require('./gamerunner');
const profiler = require('shared/util/profiler');

class GameQueue {

    constructor() {
        this.actions = new Queue();
        this.isProcessing = false;

        //holds games in busy state
        this.gameBusy = {};

        this.gameActions = {};

        this.lastProcessed = 0;

    }

    start() {
        events.addNextActionListener(this.onNextAction.bind(this));
    }

    onNextAction(action) {

        if (!action.type) {
            console.error("Not an action: ", action);
            return;
        }

        if (!action.room_slug) {
            console.error("Missing room_slug: ", action);
            return;
        }

        this.actions.enqueue(action);
        this.tryDequeue();
    }

    async tryDequeue() {
        let now = (new Date()).getTime();
        let elapsed = (now - this.lastProcessed) / 1000;
        if ((this.isProcessing && elapsed < 60) || this.actions.size() == 0) {
            return;
        }

        this.lastProcessed = now;
        this.isProcessing = true;
        {
            try {
                let action = this.actions.dequeue();
                let meta = await storage.getRoomMeta(action.room_slug);
                if (!meta) {
                    this.isProcessing = false;
                    return;
                }

                let gamekey = meta.game_slug + meta.version;
                if (!this.gameActions[gamekey]) {
                    this.gameActions[gamekey] = new Queue();
                }
                this.gameActions[gamekey].enqueue(action);
                this.tryRunGame(gamekey);
            }
            catch (e) {
                console.error(e);
            }

        }
        this.isProcessing = false;

        this.tryDequeue();
    }

    //keeps a nested queue for game + version, since downloading server js and db takes time
    // we want to ensure the actions are processed in correct order and must wait for the files to be downloaded
    async tryRunGame(gamekey) {

        if (this.gameBusy[gamekey] || !this.gameActions[gamekey] || this.gameActions[gamekey].size() == 0) {
            return;
        }

        // profiler.StartTime("GameQueue.tryRunGame");
        this.gameBusy[gamekey] = true;
        try {
            let action = this.gameActions[gamekey].peek();
            let meta = await storage.getRoomMeta(action.room_slug);

            await gamedownloader.downloadServerFiles(action, meta);

            let key = meta.game_slug + '/server.bundle.' + meta.version + '.js';
            let gameServer = storage.getGameServer(key);

            if (!gameServer) {
                this.gameBusy[gamekey] = false;
                this.tryRunGame(gamekey);
                return;
            }

            action = this.gameActions[gamekey].dequeue();
            let passed = await gamerunner.runAction(action, gameServer.script, meta);
            if (!passed) {
                let gamekey = meta.game_slug + meta.version;
                this.gameActions[gamekey].clear();
                this.isProcessing = false;
            }
        }
        catch (e) {
            console.error(e);
        }
        this.gameBusy[gamekey] = false;

        this.tryRunGame(gamekey);
        // profiler.EndTime("GameQueue.tryRunGame");
        // profiler.EndTime('GameServer-loop');
    }

}

module.exports = new GameQueue();
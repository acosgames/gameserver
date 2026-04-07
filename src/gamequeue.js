var Queue = require('queue-fifo');

// const events = require('./events');
const storage = require('./storage');

const gamedownloader = require('./gamedownloader');
const gamerunner = require('./gamerunner');
const profiler = require('shared/util/profiler.js');

class GameQueue {

    constructor() {
        this.actions = new Queue();
        this.isDequeuing = false;

        // holds rooms in busy state
        this.roomBusy = {};

        this.roomActions = {};

    }

    start() {
        // events.addNextActionListener(this.onNextAction.bind(this));
    }

    onNextAction(action) {

        let firstAction = action;
        if (Array.isArray(action)) {
            firstAction = action[0];
        }

        if (!firstAction.type) {
            console.error("Not an action: ", firstAction);
            return;
        }

        if (!firstAction.room_slug) {
            console.error("Missing room_slug: ", firstAction);
            return;
        }

        this.actions.enqueue(action);
        this.tryDequeue();
    }

    async tryDequeue() {
        if (this.isDequeuing || this.actions.size() == 0) {
            return;
        }

        profiler.StartTime('tryDequeue');
        this.isDequeuing = true;
        try {
            while (this.actions.size() > 0) {
                let action = this.actions.dequeue();
                let firstAction = action;
                if (Array.isArray(action)) {
                    firstAction = action[0];
                }

                if (!firstAction || !firstAction.room_slug) {
                    console.error("tryDequeue missing room_slug", firstAction);
                    continue;
                }

                let room_slug = firstAction.room_slug;
                if (!this.roomActions[room_slug]) {
                    this.roomActions[room_slug] = new Queue();
                }
                this.roomActions[room_slug].enqueue(action);
                this.tryRunGame(room_slug);
            }
        } catch (e) {
            console.error(e);
        } finally {
            this.isDequeuing = false;
            profiler.EndTime('tryDequeue');
        }
    }

    // if (Array.isArray(actions)) {
    //     for (let i = 0; i < actions.length; i++) {
    //         if (actions[i])
    //             events.emitNextAction(actions[i]);
    //     }
    // }


    // keeps a nested queue per room_slug: sequential per room, concurrent across different rooms
    async tryRunGame(room_slug) {

        if (this.roomBusy[room_slug] || !this.roomActions[room_slug] || this.roomActions[room_slug].size() == 0) {
            return;
        }

        profiler.StartTime("GameQueue.tryRunGame");
        this.roomBusy[room_slug] = true;
        try {
            while (this.roomActions[room_slug] && this.roomActions[room_slug].size() > 0) {
                let action = this.roomActions[room_slug].peek();
                let firstAction = action;
                if (Array.isArray(firstAction)) {
                    firstAction = action[0];
                }

                // profiler.StartTime("GameQueue.tryRunGame.roomMeta");
                let meta = await storage.getRoomMeta(room_slug);
                if (!meta) {
                    this.roomActions[room_slug].clear();
                    console.log("tryRunGame missing meta", room_slug, firstAction?.user);
                    break;
                }
                // profiler.EndTime("GameQueue.tryRunGame.roomMeta");

                // profiler.StartTime("GameQueue.tryRunGame.serverFiles");
                await gamedownloader.downloadServerFiles(firstAction, meta, gamerunner.getIsolate());
                // profiler.EndTime("GameQueue.tryRunGame.serverFiles");

                let key = meta.game_slug + '/server.bundle.' + meta.version + '.js';
                let gameServer = storage.getGameServer(key);

                if (!gameServer) {
                    console.log("tryRunGame missing gameserver", key);
                    break;
                }

                // profiler.StartTime("GameQueue.tryRunGame.runAction");
                action = this.roomActions[room_slug].dequeue();
                let passed = await gamerunner.runAction(action, gameServer.script, meta);
                if (!passed) {
                    this.roomActions[room_slug].clear();
                    break;
                }
                // profiler.EndTime("GameQueue.tryRunGame.runAction");
            }
        }
        catch (e) {
            console.error(e);
        }
        this.roomBusy[room_slug] = false;

        profiler.EndTime("GameQueue.tryRunGame");

        if (this.roomActions[room_slug] && this.roomActions[room_slug].size() > 0) {
            this.tryRunGame(room_slug);
        }
        // profiler.EndTime('GameServer-loop');
    }

}

module.exports = new GameQueue();
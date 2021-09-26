const rabbitmq = require('fsg-shared/services/rabbitmq');
const redis = require('fsg-shared/services/redis');
const events = require('./events');
const storage = require('./storage');
const gamedownloader = require('./gamedownloader');
const profiler = require('fsg-shared/util/profiler');

class GameReceiver {

    constructor() {

    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    start() {
        return new Promise(async (rs, rj) => {
            while (!(rabbitmq.isActive() && redis.isActive)) {

                console.warn("[GameReceiver] waiting on rabbitmq and redis...");
                await this.sleep(1000);
                //return;
            }

            rabbitmq.subscribeQueue('loadGame', this.onLoadGame.bind(this));
            events.addSkipListener(this.onSkip.bind(this));
            rs(true);
        })

    }

    async onSkip(msg) {
        let room_slug = msg.room_slug;
        let meta = await storage.getRoomMeta(room_slug);
        let game_slug = meta.game_slug;

        this.onNextAction(game_slug, msg);
    }

    async onLoadGame(msg) {
        let room_slug = msg.room_slug;
        let meta = await storage.getRoomMeta(room_slug);
        let game_slug = meta.game_slug;

        // let worker = this.games[game_slug];
        if (!storage.isLoaded(game_slug)) {
            await this.createGameReceiver(game_slug, msg);
        }

        events.emitLoadGame({ msg, meta });
        return true;
    }

    async onNextAction(game_slug, msg) {
        profiler.StartTime('GameServer-loop');

        if (Array.isArray(msg)) {
            if (!storage.isLoaded(game_slug)) {
                await this.createGameReceiver(game_slug, msg[0]);
            }
            for (let i = 0; i < msg.length; i++) {
                events.emitNextAction(msg[i]);
            }
        }
        else {
            if (!storage.isLoaded(game_slug)) {
                await this.createGameReceiver(game_slug, msg);
            }
            events.emitNextAction(msg);
        }

        return true;
    }

    async createGameReceiver(game_slug, msg) {

        if (storage.isLoaded(game_slug))
            return false;

        await gamedownloader.downloadServerFiles(msg);
        // let worker = storage.workers[this.nextWorker];
        storage.setLoaded(game_slug, true);
        // this.nextWorker = (this.nextWorker + 1) % this.workers.length;

        await rabbitmq.subscribeQueue(game_slug, async (gameMessage) => {
            return await this.onNextAction(game_slug, gameMessage);
        });

        return true;
    }
}

module.exports = new GameReceiver();
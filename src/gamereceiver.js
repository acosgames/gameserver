const rabbitmq = require('fsg-shared/services/rabbitmq');
const events = require('./events');
const storage = require('./storage');

class GameReceiver {

    constructor() {

    }

    setup() {
        if (!this.mq.isActive() || !this.redis.isActive) {
            setTimeout(this.setup.bind(this), 2000);
            return;
        }

        rabbitmq.subscribeQueue('loadGame', this.onLoadGame.bind(this));
        events.addSkipListener(this.onSkip.bind(this));
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
            await this.createGameReceiver(msg, meta);
        }

        events.emitLoadGame({ msg, meta });
        return true;
    }

    async onNextAction(game_slug, msg) {
        // console.time('WorkerManagerLoop');
        // let room_slug = msg.room_slug;
        // let meta = await this.getRoomMeta(room_slug);
        // let game_slug = meta.game_slug;

        if (!storage.isLoaded(game_slug)) {
            await this.createGameReceiver(game_slug, msg);
        }

        events.emitNextAction(msg);
        // worker.postMessage(msg);
        return true;
    }

    async createGameReceiver(game_slug, msg) {

        if (storage.isLoaded(game_slug))
            return false;

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
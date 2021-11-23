const rabbitmq = require('fsg-shared/services/rabbitmq');
const redis = require('fsg-shared/services/redis');
const events = require('./events');
const storage = require('./storage');
const gamedownloader = require('./gamedownloader');
const profiler = require('fsg-shared/util/profiler');
const { generateAPIKEY } = require('fsg-shared/util/idgen');
const fs = require('fs');

process.on('SIGTERM', signal => {
    cleanup();
    console.error(`Process ${process.pid} received a SIGTERM signal`, signal)
    process.exit(0)
})

process.on('SIGINT', signal => {
    cleanup();
    console.error(`Process ${process.pid} has been interrupted`, signal)
    process.exit(0)
})
process.on('beforeExit', code => {
    cleanup();
    console.error(`Process will exit with code: ${code}`)
    process.exit(code)
});

process.on('uncaughtException', err => {
    cleanup();
    console.error(`Uncaught Exception: ${err.message}`)
    process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
    cleanup();
    console.error('Unhandled rejection at ', promise, `reason: ${reason}`)
    process.exit(1)
})

process.on('message', function (msg) {
    if (msg == 'shutdown' || msg.type == 'shutdown') {
        cleanup();
        console.error('Message Shutdown ', msg)
    }
});

function cleanup() {
    let exchanges = rabbitmq.getInChannel().exchanges;
    for (var exchange in exchanges) {
        let parts = exchange.pattern.split('/');
        let game_slug = parts[0];
        let room_slug = parts[1];
        let msg = { room_slug }
        rabbitmq.publishQueue('loadGame', { msg })
    }
}

class GameReceiver {

    constructor() {
        let queueKeyPath = './saved/queuekey.txt';
        try {
            let queuekey = fs.readFileSync(queueKeyPath, { encoding: 'utf8', flag: 'r' });
            if (queuekey.length == 0)
                throw "no key exists";
            storage.setQueueKey(queuekey);
        }
        catch (e) {
            let queuekey = generateAPIKEY();
            storage.setQueueKey(queuekey);
            fs.writeFileSync(queueKeyPath, queuekey);
        }

        this.gameQueue = null;
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

            rabbitmq.subscribe('serverWatch', 'healthRequest', this.onHealthCheck.bind(this));
            rabbitmq.subscribeQueue('loadGame', this.onLoadGame.bind(this));
            events.addSkipListener(this.onSkip.bind(this));
            rs(true);
        })

    }

    async onHealthCheck(msg) {
        rabbitmq.publish('serverWatch', 'healthResponse', { id: storage.getQueueKey(), aps: storage.calculateActionRate() })
    }

    async onSkip(msg) {
        let room_slug = msg.room_slug;
        let meta = await storage.getRoomMeta(room_slug);
        let game_slug = meta.game_slug;

        this.onNextAction(game_slug, msg);
    }

    async onLoadGame(payload) {
        let msg = payload.msg;
        let initialActions = payload.actions;

        let room_slug = msg.room_slug;
        let meta = await storage.getRoomMeta(room_slug);
        let game_slug = meta.game_slug;

        // let worker = this.games[game_slug];
        // if (!storage.isLoaded(game_slug)) {
        let key = payload.key || (game_slug + '/' + room_slug);
        await this.createGameReceiver(key, initialActions);
        // }

        events.emitLoadGame({ msg, meta });
        return true;
    }

    async onNextAction(actions) {
        profiler.StartTime('GameServer-loop');

        if (Array.isArray(actions)) {
            // if (!storage.isLoaded(game_slug)) {
            //     await this.createGameReceiver(game_slug, msg[0]);
            // }
            for (let i = 0; i < actions.length; i++) {
                events.emitNextAction(actions[i]);
            }
        }
        else {
            // if (!storage.isLoaded(game_slug)) {
            //     await this.createGameReceiver(game_slug, msg);
            // }
            events.emitNextAction(actions);
        }

        return true;
    }

    async createGameReceiver(key, initialActions) {


        // await gamedownloader.downloadServerFiles(msg);
        // let worker = storage.workers[this.nextWorker];
        // storage.setLoaded(key, true);
        // this.nextWorker = (this.nextWorker + 1) % this.workers.length;

        let queuekey = await rabbitmq.subscribe('action', key, async (gameMessage) => {
            return await this.onNextAction(gameMessage);
        }, storage.getQueueKey())

        if (queuekey != storage.getQueueKey()) {
            storage.setQueueKey(queuekey);
            fs.writeFileSync(queueKeyPath, queuekey);
        }
        if (initialActions && initialActions.length > 0)
            this.onNextAction(initialActions);

        // await rabbitmq.subscribeQueue(game_slug, async (gameMessage) => {
        //     return await this.onNextAction(game_slug, gameMessage);
        // });

        return true;
    }
}

module.exports = new GameReceiver();
const rabbitmq = require('shared/services/rabbitmq');
const redis = require('shared/services/redis');
const events = require('./events');
const storage = require('./storage');
const gamedownloader = require('./gamedownloader');
const profiler = require('shared/util/profiler');
const { generateAPIKEY } = require('shared/util/idgen');
const fs = require('fs');
const gamerunner = require('./gamerunner');

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
    for (var key in exchanges) {
        let exchange = exchanges[key];
        let parts = exchange.pattern.split('/');
        let game_slug = parts[0];
        let room_slug = parts[1];
        let msg = { room_slug }
        rabbitmq.publishQueue('loadGame', { msg })
    }
}

class GameReceiver {

    constructor() {
        // let queueKeyPath = './saved/queuekey.txt';
        // try {
        //     let queuekey = fs.readFileSync(queueKeyPath, { encoding: 'utf8', flag: 'r' });
        //     if (queuekey.length == 0)
        //         throw "no key exists";
        //     storage.setQueueKey(queuekey);
        // }
        // catch (e) {
        //     let queuekey = generateAPIKEY();
        //     storage.setQueueKey(queuekey);
        //     fs.writeFileSync(queueKeyPath, queuekey);
        // }
        this.qServer = null;
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


            this.qServer = await rabbitmq.subscribeAutoDelete('serverWatch', 'healthRequest', this.onHealthCheck.bind(this));
            let qDecomission = await rabbitmq.subscribeAutoDelete('decomission', this.qServer, this.onDecomission.bind(this));

            let qAction = await rabbitmq.findExistingQueue('action');
            storage.setQueueKey(qAction);
            rabbitmq.subscribeQueue(qAction, this.onNextAction.bind(this));

            rabbitmq.subscribeQueue('loadGame', this.onLoadGame.bind(this));
            events.addSkipListener(this.onSkip.bind(this));
            events.addGameStartListener(this.onGameStart.bind(this));
            rs(true);
        })

    }

    async onDecomission(msg) {
        try {
            //stop receiving new games
            await rabbitmq.unsubscribeQueue('loadGame');

            //exit once gameserver is idle for more than 30 minutes
            while (true) {
                let seconds = storage.getLastActionRunSeconds();
                if (seconds > 1800) {
                    process.exit(0);
                    return;
                }
                await this.sleep(60000);
            }
        }
        catch (e) {
            console.error(e);
        }
    }

    async onHealthCheck(msg) {
        rabbitmq.publish('serverWatch', 'healthResponse', { id: this.qServer, aps: storage.calculateActionRate() })
    }

    async onSkip(msg) {
        let room_slug = msg.room_slug;
        let meta = await storage.getRoomMeta(room_slug);
        if (!meta)
            return;
        // let game_slug = meta.game_slug;

        this.onNextAction(msg);
    }

    async onGameStart(msg) {
        let room_slug = msg.room_slug;
        let meta = await storage.getRoomMeta(room_slug);
        if (!meta)
            return;
        // let game_slug = meta.game_slug;

        this.onNextAction(msg);
    }

    async onLoadGame(msg) {

        let initialActions = msg.actions;

        let room_slug = msg.room_slug;
        let meta = await storage.getRoomMeta(room_slug);
        if (!meta) {
            rabbitmq.publish('ws', 'onRoomUpdate', { type: 'error', room_slug, payload: true });
            return false;
        }

        let game_slug = meta.game_slug;

        let key = msg.key || (game_slug + '/' + room_slug);
        await this.createGameReceiver(key, initialActions);

        events.emitLoadGame({ msg, meta });
        return true;
    }

    async onNextAction(actions) {
        //profiler.StartTime('GameServer-loop');
        console.log("ForwardActionReceived", Date.now())
        if (actions) {
            events.emitNextAction(actions);
        }
        // if (Array.isArray(actions)) {
        //     for (let i = 0; i < actions.length; i++) {
        //         if (actions[i])
        //             events.emitNextAction(actions[i]);
        //     }
        // }
        // else {
        //     if (actions)
        //         events.emitNextAction(actions);
        // }

        return true;
    }

    async createGameReceiver(key, initialActions) {

        //subscribe to the game room
        storage.addRoom(key);
        let queueKey = storage.getQueueKey();
        await rabbitmq.subscribe('action', key, async (gameMessage) => {
            return await this.onNextAction(gameMessage);
        }, queueKey)

        //save the queue key for restarts
        // let queueKeyPath = './saved/queuekey.txt';
        // if (queuekey != storage.getQueueKey()) {
        //     storage.setQueueKey(queuekey);
        //     fs.writeFileSync(queueKeyPath, queuekey);
        // }

        //run any initial actions sent with the load game request
        if (initialActions && initialActions.length > 0)
            this.onNextAction(initialActions);

        return true;
    }
}

module.exports = new GameReceiver();
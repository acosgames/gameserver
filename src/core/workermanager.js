
const { GeneralError } = require('fsg-shared/util/errorhandler');
const credutil = require('fsg-shared/util/credentials');
const { getLocalAddr } = require('fsg-shared/util/address');

const InstanceLocalService = require('fsg-shared/services/instancelocal');
const local = new InstanceLocalService();

const RedisService = require('fsg-shared/services/redis');
const rabbitmq = require('fsg-shared/services/rabbitmq');

const os = require('os')
const cpuCount = Math.min(os.cpus().length - 1, 1);

const { Worker } = require("worker_threads")

module.exports = class WorkerManager {
    constructor(credentials) {

        this.credentials = credentials || credutil();

        this.games = {};

        this.redis = RedisService;
        this.redisCred = null;
        this.mq = rabbitmq;

        this.nextWorker = 0;
        this.workers = [];

    }

    async connect() {
        await this.registerOnline();
        await this.connectToRedis();
        await this.connectToMQ();

        await this.createWorkers();

        //this.mq.subscribe('gameserver', 'hasgame', this.onHasGame.bind(this));
        this.mq.subscribeQueue('nextAction', this.onNextAction.bind(this));
        this.mq.subscribeQueue('loadGame', this.onLoadGame.bind(this));
    }

    async onLoadGame(msg) {
        let game_slug = msg.game_slug;

        // let worker = this.games[game_slug];
        if (!(game_slug in this.games)) {
            await this.createGame(msg);
        }
    }

    async onNextAction(msg) {

        let worker = this.games[msg.game_slug];
        if (!worker) {
            await this.createGame(msg);
        }

        worker.postMessage(msg);
    }

    async createGame(msg) {
        let game_slug = msg.game_slug;

        if (game_slug in this.games) {
            return;
        }

        await this.mq.subscribeQueue(game_slug, (gameMessage) => {
            gameMessage.game_slug = game_slug;
            this.onNextAction(gameMessage);
            return true;
        });

        let worker = this.workers[this.nextWorker];
        this.games[game_slug] = worker;

        this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    }

    createWorkers() {
        for (var i = 0; i < cpuCount; i++) {
            this.workers.push(this.createWorker(i));
        }
    }

    createWorker(index) {
        const worker = new Worker('./src/core/worker.js', { workerData: { index, redisCred: this.redisCred } });
        worker.on("message", (msg) => {
            console.log("WorkerManager [" + index + "] received: ", msg);
        });
        worker.on("online", (err) => {

        })
        worker.on("error", (err) => {
            console.error(err);
        })
        worker.on("exit", code => {
            if (code !== 0) {
                console.error(code);
                throw new Error(`Worker stopped with exit code ${code}`)
            }
        })

        return worker;
    }

    async registerOnline() {

        let params = {
            public_addr: '',
            private_addr: getLocalAddr(),
            hostname: "gameserver-1",
            zone: 0,
            instance_type: 3
        }
        this.server = await local.register(params);
        console.log("GameServer registered: ", this.server);
        return this.server;
    }


    async connectToMQ(options) {

        let clusters = this.server.clusters;
        //choose a random MQ server within our zone
        let mqs = clusters.filter(v => v.instance_type == 5);
        this.mqCred = mqs[Math.floor(Math.random() * mqs.length)];
        let pubAddr = this.mqCred.public_addr;
        let privAddr = this.mqCred.private_addr;
        let parts = pubAddr.split(":");
        let host = parts[0];
        let port = parts[1];
        host = "amqp://" + this.credentials.platform.mqCluster.user + ":" + this.credentials.platform.mqCluster.pass + "@" + host + ":" + port;
        let mqOpts = {
            host
        }

        this.mq.connect(mqOpts);
    }

    async connectToRedis(options) {
        if (!this.server || !this.server.clusters) {
            setTimeout(() => { this.connect(options) }, this.credentials.platform.retryTime);
            return;
        }

        let clusters = this.server.clusters;
        //choose a random Redis server within our zone
        let redises = clusters.filter(v => v.instance_type == 2);
        this.cluster = redises[Math.floor(Math.random() * redises.length)];
        let pubAddr = this.cluster.public_addr;
        let privAddr = this.cluster.private_addr;
        let parts = pubAddr.split(":");
        let host = parts[0];
        let port = parts[1];
        this.redisCred = {
            host, port
        }

        this.redis.connect(this.redisCred);
    }
}
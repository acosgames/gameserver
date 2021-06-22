
const { GeneralError } = require('fsg-shared/util/errorhandler');
const credutil = require('fsg-shared/util/credentials');
const { getLocalAddr } = require('fsg-shared/util/address');

const InstanceLocalService = require('fsg-shared/services/instancelocal');
const local = new InstanceLocalService();
const redis = require('fsg-shared/services/redis');

const RedisService = require('fsg-shared/services/redis');
const rabbitmq = require('fsg-shared/services/rabbitmq');

const os = require('os')
const cpuCount = Math.min(os.cpus().length - 1, 1);

const profiler = require('fsg-shared/util/profiler')

const { Worker } = require("worker_threads")

var PriorityQueue = require('priorityqueuejs');



module.exports = class WorkerManager {
    constructor(credentials) {

        this.credentials = credentials || credutil();

        this.games = {};
        this.cache = {};

        this.redis = RedisService;
        this.redisCred = null;
        this.mq = rabbitmq;

        this.nextWorker = 0;
        this.workers = [];

        this.deadlines = new PriorityQueue(function (a, b) {
            return b.end - a.end;
        });

        this.setup();

    }

    setup() {
        if (!this.mq.isActive() || !this.redis.isActive) {
            setTimeout(this.setup.bind(this), 2000);
            return;
        }

        //this.mq.subscribe('gameserver', 'hasgame', this.onHasGame.bind(this));
        this.mq.subscribeQueue('nextAction', this.onNextAction.bind(this));
        this.mq.subscribeQueue('loadGame', this.onLoadGame.bind(this));

        setInterval(() => {

            this.processDeadlines();

        }, 500)
    }


    async connect() {
        await this.registerOnline();
        // await this.connectToRedis();
        // await this.connectToMQ();

        await this.createWorkers();


    }

    async onLoadGame(msg) {
        let game_slug = msg.meta.game_slug;

        // let worker = this.games[game_slug];
        if (!(game_slug in this.games)) {
            await this.createGame(msg);
        }

        return true;
    }

    async onNextAction(msg) {
        profiler.StartTime('WorkerManagerLoop');
        let worker = this.games[msg.meta.game_slug];
        if (!worker) {
            worker = await this.createGame(msg);
        }
        if (!worker)
            return false;

        worker.postMessage(msg);
        return true;
    }

    async createGame(msg) {
        let game_slug = msg.meta.game_slug;

        if (game_slug in this.games) {
            return null;
        }

        let worker = this.workers[this.nextWorker];
        this.games[game_slug] = worker;

        this.nextWorker = (this.nextWorker + 1) % this.workers.length;

        await this.mq.subscribeQueue(game_slug, async (gameMessage) => {
            if (!gameMessage.meta)
                gameMessage.meta = {}
            gameMessage.meta.game_slug = game_slug;
            return await this.onNextAction(gameMessage);
        });


        return worker;
    }

    async createWorkers() {
        for (var i = 0; i < cpuCount; i++) {
            this.workers.push(await this.createWorker(i));
        }
    }

    async createWorker(index) {
        const worker = new Worker('./src/worker.js', { workerData: { index, redisCred: this.redisCred } });
        worker.on("message", async (msg) => {
            // console.log("WorkerManager [" + index + "] received: ", msg);

            if (msg.type == 'join') {
                // await this.mq.publish('ws', 'onJoinResponse', msg);
            }
            else if (msg.type == 'update' || msg.type == 'finish' || msg.type == 'error') {
                // await this.mq.publish('ws', 'onRoomUpdate', msg);
                if (!msg.payload.killGame && msg.payload.timer && msg.payload.timer.end) {
                    this.addRoomDeadline(msg.meta, msg.payload.timer.end)
                }
            }
            profiler.EndTime('WorkerManagerLoop');
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

    async processDeadlines() {
        try {
            if (this.deadlines.size() == 0)
                return;
            let next = this.deadlines.peek();

            let room_slug = next.room_slug;
            let meta = await this.getTimerData(room_slug);
            let now = (new Date()).getTime();

            if (!meta || typeof meta.end == 'undefined' || meta.end != next.end) {
                this.deadlines.deq();
                return;
            }

            if (now < meta.end)
                return;


            let action = {
                type: 'skip',
                meta,
            }
            this.onNextAction(action);
            this.deadlines.deq();
            this.clearRoomDeadline(room_slug);
            this.processDeadlines();
        }
        catch (e) {
            console.error("ProcessTime Error: ", e)
        }

    }


    async getTimerData(room_slug) {
        let timerData = this.cache[room_slug + '/timer'];
        if (typeof timerData === 'undefined') {
            timerData = await redis.get(room_slug + '/timer');
        }
        return timerData;
    }

    async addRoomDeadline(meta, end) {
        let room_slug = meta.room_slug;
        let data = {
            game_slug: meta.game_slug,
            gameid: meta.gameid,
            version: meta.version,
            room_slug,
            end,
        }

        this.cache[room_slug + '/timer'] = data;
        // cache.set(room_slug + '/timer', data);
        redis.set(room_slug + '/timer', data);
        this.deadlines.enq({ end, room_slug })
    }

    async clearRoomDeadline(room_slug) {
        delete this.cache[room_slug + '/timer'];
        await redis.del(room_slug + '/timer');
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


    // async connectToMQ(options) {

    //     let clusters = this.server.clusters;
    //     //choose a random MQ server within our zone
    //     let mqs = clusters.filter(v => v.instance_type == 5);
    //     this.mqCred = mqs[Math.floor(Math.random() * mqs.length)];
    //     let pubAddr = this.mqCred.public_addr;
    //     let privAddr = this.mqCred.private_addr;
    //     let parts = pubAddr.split(":");
    //     let host = parts[0];
    //     let port = parts[1];
    //     host = "amqp://" + this.credentials.platform.mqCluster.user + ":" + this.credentials.platform.mqCluster.pass + "@" + host + ":" + port;
    //     let mqOpts = {
    //         host
    //     }

    //     this.mq.connect(mqOpts);
    // }

    // async connectToRedis(options) {
    //     if (!this.server || !this.server.clusters) {
    //         setTimeout(() => { this.connect(options) }, this.credentials.platform.retryTime);
    //         return;
    //     }

    //     let clusters = this.server.clusters;
    //     //choose a random Redis server within our zone
    //     let redises = clusters.filter(v => v.instance_type == 2);
    //     this.cluster = redises[Math.floor(Math.random() * redises.length)];
    //     let pubAddr = this.cluster.public_addr;
    //     let privAddr = this.cluster.private_addr;
    //     let parts = pubAddr.split(":");
    //     let host = parts[0];
    //     let port = parts[1];
    //     this.redisCred = {
    //         host, port
    //     }

    //     this.redis.connect(this.redisCred);
    // }
}
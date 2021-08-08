const { workerData, parentPort } = require("worker_threads")
const fs = require('fs');
const { VM, VMScript, NodeVM } = require('vm2');

const profiler = require('fsg-shared/util/profiler')
const redis = require('fsg-shared/services/redis');
const rabbitmq = require('fsg-shared/services/rabbitmq');

const NodeCache = require("node-cache");

const ObjectStorageService = require("fsg-shared/services/objectstorage");
const s3 = new ObjectStorageService();

const r = require('fsg-shared/services/room');

var Queue = require('queue-fifo');

const cache = require('fsg-shared/services/cache');

// const { version } = require("os");
var globalDatabase = null;
var globalRoomState = null;
var globalAction = {};
var globalResult = null;
var globalDone = null;

var globals = {
    log: (msg) => { console.log(msg) },
    error: (msg) => { console.error(msg) },
    finish: (newGame) => {
        try {
            globalResult = cloneObj(newGame);
        }
        catch (e) {
            console.error(e);
        }
    },
    game: () => cloneObj(globalRoomState),
    actions: () => cloneObj(globalAction),
    killGame: () => {
        globalDone = true;
    },
    database: () => {
        return globalDatabase;
    }
};

const vm = new VM({
    console: false,
    wasm: false,
    eval: false,
    fixAsync: false,
    //timeout: 100,
    sandbox: { globals },
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function cloneObj(obj) {
    if (typeof obj === 'object')
        return JSON.parse(JSON.stringify(obj));
    return obj;
}

const index = workerData.index;
const redisCred = workerData.redisCred;


class FSGWorker {
    constructor() {
        this.actions = new Queue();
        this.gameHistory = [];
        this.games = {};
        this.databases = {};
        this.roomStates = {};
        this.roomCache = new NodeCache({ stdTTL: 300, checkperiod: 150 });
        this.mq = rabbitmq;

        this.isProcessing = false;

        console.log("Started worker: ", index);
        this.start();
    }

    setup() {
        if (!this.mq.isActive() || !this.redis.isActive) {
            setTimeout(this.setup.bind(this), 2000);
            return;
        }
    }

    async onAction(msg) {

        // console.time('ActionLoop');

        if (!msg.type) {
            console.error("Not an action: ", msg);
            return;
        }



        let room_slug = msg.room_slug;
        let meta = await this.getRoomMeta(room_slug);
        let game_slug = meta.game_slug;
        let version = meta.version;

        if (!game_slug || !room_slug)
            return;




        if (msg.type == 'join') {

        }


        //console.log("Action Queued: ", msg);
        this.actions.enqueue(msg);
        this.tryDequeue();
        // console.timeEnd('ActionLoop');
    }

    async downloadServerFiles(msg) {
        let room_slug = msg.room_slug;

        let meta = await this.getRoomMeta(room_slug);


        try {
            let key = meta.gameid + '/server.bundle.' + meta.version + '.js';
            let script = await this.downloadGameJS(key);
            if (!script) {
                console.error("Script unable to be created for: ", msg);
            }
        } catch (e) {
            console.error("Error: Script unable to be created for: ", msg);
            console.log('Error:', e);
        }

        if (!meta.db)
            return;

        try {
            let key = meta.gameid + '/server.db.' + meta.version + '.json';
            let db = await this.downloadGameDatabase(key);
            if (!db) {
                console.error("Database unable to be created for: ", msg);
            }
        } catch (e) {
            console.error("Error: Database unable to be created for: ", msg);
            console.log('Error:', e);
        }
    }

    async tryDequeue() {
        if (this.isProcessing || this.actions.size() == 0) {
            return;
        }
        // console.time('tryDequeue');

        this.isProcessing = true;

        // let peeked = this.actions.peek();

        let action = this.actions.dequeue();
        if (!action.room_slug) {
            this.tryDequeue();
            this.isProcessing = false;
            return;
        }

        let meta = await this.getRoomMeta(action.room_slug);
        await this.downloadServerFiles(action);
        let key = meta.gameid + '/server.bundle.' + meta.version + '.js';
        let game = await this.getGame(key);
        if (!game) {
            this.actions.enqueue(action);
            this.tryDequeue();
            this.isProcessing = false;
            return;
        }

        await this.runAction(action, game, meta);

        this.isProcessing = false;
        // console.timeEnd('tryDequeue');
        this.tryDequeue();
    }

    async start() {
        try {

            await redis.connect(redisCred);

            parentPort.on('message', this.onAction.bind(this));
            parentPort.on('close', this.onClose.bind(this));
            parentPort.postMessage({ status: "READY" });
            process.on('uncaughtException', this.onException)

            setInterval(() => { }, 100000000);

            // this.startLoop();
        }
        catch (e) {
            console.error(e);
        }
    }

    async startLoop() {
        while (true) {

            if (this.actions.size() > 0) {
                this.mainLoop();
                continue;

            }

            await sleep(2);
            // continue;
        }
    }

    async getGame(key) {
        return this.games[key];
    }


    async getRoomState(room_slug) {
        let game = await cache.get(room_slug);
        // let game = this.roomStates[room_slug];
        // if (!game) {
        //     game = await redis.get(room_slug);
        // }
        if (!game) {
            game = this.makeGame(false, game);
            await cache.set(room_slug, game);
        }


        //this.roomStates[room_slug] = game;
        return game;
    }

    async mainLoop() {

    }

    async getDatabase(meta) {
        if (!meta.db)
            return null;

        let key = meta.gameid + '/server.db.' + meta.version + '.json';
        let db = this.databases[key];
        if (!db) {
            try {
                let db = await this.downloadGameDatabase(key);
                if (!db) {
                    console.error("Database unable to be created for: ", meta);
                }
                return db;
            } catch (e) {
                console.error("Error: Database unable to be created for: ", meta);
                console.log('Error:', e);
            }
        }

        return db;
    }

    async onPlayerJoin(action) {
        let id = action.user.id;
        let name = action.user.name;
        let room_slug = action.room_slug;

        if (!id) {
            console.error("Invalid player: " + id);
            return;
        }

        // let roomState = globalRoomState;//let roomState = await this.getRoomState(room_slug);
        if (!(id in globalRoomState.players)) {
            globalRoomState.players[id] = { name }
            r.assignPlayerRoom(id, room_slug, action.payload.game_slug);
        }
        else {
            globalRoomState.players[id].name = name;
        }

        //this.saveRoomState(room_slug, roomState);
        // this.mq.publish('ws', 'onJoinResponse', { type: 'join', payload: { id, room_slug } });
        // parentPort.postMessage({ type: 'join', payload: { id, room_slug } });
    }

    calculateTimeleft(roomState) {
        if (!roomState || !roomState.timer || !roomState.timer.end)
            return 0;

        let deadline = roomState.timer.end;
        let now = (new Date()).getTime();
        let timeleft = deadline - now;

        return timeleft;
    }

    processTimelimit(timer) {

        if (!timer || !timer.set)
            return;

        if (typeof timer.set === 'undefined')
            return;

        let seconds = Math.min(60, Math.max(10, timer.set));
        let sequence = timer.seq || 0;
        let now = (new Date()).getTime();
        let deadline = now + (seconds * 1000);
        // let timeleft = deadline - now;

        timer.end = deadline;
        timer.seconds = seconds;
        // timer.data = [deadline, seconds];
        timer.seq = sequence + 1;
        delete timer.set;
    }


    async runAction(action, game, meta) {
        console.log('runAction', action);
        let room_slug = meta.room_slug;
        globalRoomState = await this.getRoomState(room_slug);
        let db = await this.getDatabase(meta);
        switch (action.type) {
            case 'join':
                await this.onPlayerJoin(action);
                break;
            case 'leave':
                try {
                    await r.removePlayerRoom(action.user.id, room_slug)
                }
                catch (e) {
                    console.error(e);
                    return;
                }

                break;
            case 'reset':
                globalRoomState = this.makeGame(false, globalRoomState);
                break;
        }

        let timeleft = this.calculateTimeleft(globalRoomState);
        if (globalRoomState.timer) {
            action.seq = globalRoomState.timer.seq || 0;
            action.timeleft = timeleft;
        }

        globalDatabase = db;
        globalAction = [action];

        let succeeded = this.runScript(game);
        if (typeof globalDone !== 'undefined' && globalDone) {
            globalResult.killGame = true;
            globalDone = false;
        }

        if (globalResult) {
            this.processTimelimit(globalResult.timer);
            await this.saveRoomState(action, meta, globalResult);
        }
        let type = 'update';
        if (globalResult.killGame == true)
            type = 'finish';
        if (!succeeded) {
            type = 'error';
        }
        if (action.type == 'join') {
            type = 'join';
            globalResult.join = action.user.id;
        }
        else if (action.type == 'leave') {
            type = 'leave';
            globalResult.leave = action.user.id;
        }


        // if (type == 'update' || type == 'finish' || type == 'error') {
        this.mq.publish('ws', 'onRoomUpdate', { type, room_slug, payload: globalResult });

        // }
        // profiler.EndTime('WorkerManagerLoop');
        this.sendMessageToManager({ type, room_slug, payload: globalResult });
        // console.timeEnd('ActionLoop');
    }

    async sendMessageToManager(msg) {
        if (msg.type == 'update' && msg.payload.timer && msg.payload.timer.end)
            parentPort.postMessage(msg);
    }
    runScript(script) {
        if (!script) {
            console.error("Game script is not loaded.");
            return false;
        }

        try {
            // console.time('Game Logic');
            {
                vm.run(script);
            }
            // console.timeEnd('Game Logic', 100);
            return true;
        }
        catch (e) {
            console.error("runScript Error: ", e);
            return false;
        }
    }

    makeGame(clearPlayers, roomState) {
        if (!roomState)
            roomState = {};
        if (roomState.killGame) {
            delete roomState['killGame'];
        }
        roomState.state = {};
        roomState.rules = {};
        roomState.next = {};
        roomState.prev = {};
        roomState.events = [];

        if (clearPlayers) {
            roomState.players = {}
        }
        else {
            let newPlayers = {};
            for (var id in roomState.players) {
                let player = roomState.players[id];
                newPlayers[id] = {
                    name: player.name
                }
            }
            roomState.players = newPlayers;
        }
        return roomState;
    }

    async getRoomMeta(room_slug) {

        let meta = await r.findRoom(room_slug);
        if (!meta) {
            return null;
        }
        return meta;
    }

    async saveRoomState(action, meta, roomState) {
        let room_slug = meta.room_slug;

        //this.roomStates[room_slug] = roomState;

        //let roomMeta = this.roomCache.get(key) || {};
        if (action.type == 'join' || action.type == 'leave') {
            // let roomMeta = await this.getRoomMeta(room_slug);
            let playerList = Object.keys(roomState.players);
            // roomMeta.player_count = playerList.length;

            try {
                r.updateRoomPlayerCount(room_slug, playerList.length);
            }
            catch (e) {
                console.error(e);
            }
            //cache.set(room_slug + '/meta', roomMeta);
        }

        cache.set(room_slug, roomState, 6000);

        // this.roomCache.set(room_slug, roomState)
        // redis.set(room_slug, roomState);

        // this.roomCache.set(key, roomMeta);
        // redis.set(key, roomMeta);

        // globalRoomState = JSON.parse(JSON.stringify(globalResult));
    }


    async downloadGameJS(key) {

        if (key in this.games)
            return this.games[key];

        var js = await s3.downloadServerScript(key);

        var script = new VMScript(js);

        this.games[key] = script;
        return script;
    }

    async downloadGameDatabase(key) {

        if (key in this.databases)
            return this.databases[key];

        var json = await s3.downloadServerScript(key);

        this.databases[key] = JSON.parse(json);
        return this.databases[key];
    }

    async downloadGameState(room_slug) {
        var state = await redis.get(room_slug);
        return state;
    }




    async onClose() {

    }

    onException(err) {
        console.error('Asynchronous error caught.', err);
    }

}


module.exports = new FSGWorker();
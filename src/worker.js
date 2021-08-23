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
const delta = require('fsg-shared/util/delta');
const rank = require('./rank');


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

        //holds games in busy state
        this.gameBusy = {};
        //holds games action queues
        this.gameActions = {};



        console.log("Started worker: ", index);
        this.start();
    }

    setup() {
        if (!this.mq.isActive() || !this.redis.isActive) {
            setTimeout(this.setup.bind(this), 2000);
            return;
        }
    }

    async onAction(action) {

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
        if (this.isProcessing || this.actions.size() == 0) {
            return;
        }

        this.isProcessing = true;
        {
            try {
                let action = this.actions.dequeue();
                let meta = await this.getRoomMeta(action.room_slug);
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

        this.gameBusy[gamekey] = true;
        {
            let action = this.gameActions[gamekey].peek();
            let meta = await this.getRoomMeta(action.room_slug);

            await this.downloadServerFiles(action, meta);

            let key = meta.gameid + '/server.bundle.' + meta.version + '.js';
            let game = await this.getGame(key);

            if (!game) {
                this.gameBusy[gamekey] = false;
                this.tryRunGame(gamekey);
                return;
            }

            action = this.gameActions[gamekey].dequeue();
            let passed = await this.runAction(action, game.script, meta);
            if (!passed) {
                let gamekey = meta.game_slug + meta.version;
                this.gameBusy[gamekey] = false;
                this.gameActions[gamekey].clear();
                this.isProcessing = false;
                let outMessage = { type: 'error', room_slug: action.room_slug, payload: { error: "Game crashed. Please report bug." } };
                this.mq.publish('ws', 'onRoomUpdate', outMessage);
                this.sendMessageToManager(outMessage);
            }
        }
        this.gameBusy[gamekey] = false;

        this.tryRunGame(gamekey);
    }

    async start() {
        try {
            await redis.connect(redisCred);

            parentPort.on('message', this.onAction.bind(this));
            parentPort.on('close', this.onClose.bind(this));
            parentPort.postMessage({ status: "READY" });
            process.on('uncaughtException', this.onException)

            setInterval(() => { }, 100000000);
        }
        catch (e) {
            console.error(e);
        }
    }

    async downloadServerFiles(action, meta) {
        let room_slug = action.room_slug;

        meta = meta || await this.getRoomMeta(room_slug);

        try {
            let key = meta.gameid + '/server.bundle.' + meta.version + '.js';
            if (!(key in this.games) || this.games[key].lastupdate != meta.latest_tsupdate) {
                let game = await this.downloadGameJS(key, meta);
                game.lastupdate = meta.latest_tsupdate;
                if (!game || !game.script) {
                    console.error("Script unable to be created for: ", action);
                }
            }
        } catch (e) {
            console.error("Error: Script unable to be created for: ", action);
            console.log('Error:', e);
        }

        if (!meta.db)
            return;

        try {
            let key = meta.gameid + '/server.db.' + meta.version + '.json';
            if (!(key in this.databases) || this.databases[key].lastupdate != meta.latest_tsupdate) {
                let db = await this.downloadGameDatabase(key, meta);
                db.lastupdate = meta.latest_tsupdate;
                if (!db) {
                    console.error("Database unable to be created for: ", action);
                }
            }
        } catch (e) {
            console.error("Error: Database unable to be created for: ", action);
            console.log('Error:', e);
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

    async getDatabase(meta) {
        if (!meta.db)
            return null;

        let key = meta.gameid + '/server.db.' + meta.version + '.json';
        let db = this.databases[key];
        if (!db || !db.db) {
            try {
                let db = await this.downloadGameDatabase(key);
                if (!db || !db.db) {
                    console.error("Database unable to be created for: ", meta);
                }
                return db.db;
            } catch (e) {
                console.error("Error: Database unable to be created for: ", meta);
                console.log('Error:', e);
            }
        }

        return db.db;
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
        // console.log('runAction', action);
        let room_slug = meta.room_slug;
        globalRoomState = await this.getRoomState(room_slug);
        let previousRoomState = cloneObj(globalRoomState);

        // if (globalRoomState.join)
        //     delete globalRoomState['join'];
        // if (globalRoomState.leave)
        //     delete globalRoomState['leave'];
        if (globalRoomState.events)
            globalRoomState.events = {};

        let db = await this.getDatabase(meta);

        try {
            switch (action.type) {
                case 'join':
                    await this.onPlayerJoin(action);
                    break;
                case 'leave':
                    await r.removePlayerRoom(action.user.id, room_slug)
                    break;
                case 'reset':
                    globalRoomState = this.makeGame(false, globalRoomState);
                    break;
            }
        }
        catch (e) {
            console.error(e);
            return false;
        }

        let timeleft = this.calculateTimeleft(globalRoomState);
        if (globalRoomState.timer) {
            action.seq = globalRoomState.timer.seq || 0;
            action.timeleft = timeleft;
        }

        globalDatabase = db;
        globalAction = [action];

        let succeeded = this.runScript(game);
        if (!succeeded) {
            return false;
        }
        let isGameover = (globalResult.events && globalResult.events.gameover);

        if (globalResult) {
            if (!isGameover)
                this.processTimelimit(globalResult.timer);
            await this.saveRoomState(action, meta, globalResult);
        }
        let type = 'update';


        if (action.type == 'join') {
            type = 'join';
            if (!globalResult.events) {
                if (!globalResult.events.join)
                    globalResult.events.join = { id: action.user.id }
                else if (!globalResult.events.join.id) {
                    globalResult.events.join.id = action.user.id;
                }
            }
            // globalResult.join = action.user.id;
        }
        else if (action.type == 'leave') {
            type = 'leave';
            if (!globalResult.events.leave)
                globalResult.events.leave = { id: action.user.id }
            else if (!globalResult.events.leave.id) {
                globalResult.events.leave.id = action.user.id;
            }

            // globalResult.leave = action.user.id;
        }

        if (isGameover) {
            type = 'finish';
            await this.processPlayerRatings(meta, globalResult.players);
        }

        if (!succeeded) {
            type = 'error';

            return false;
        }

        let dlta = delta.delta(previousRoomState, globalResult, {});

        // if (type == 'update' || type == 'finish' || type == 'error') {
        this.mq.publish('ws', 'onRoomUpdate', { type, room_slug, payload: dlta });

        // }
        // profiler.EndTime('WorkerManagerLoop');
        this.sendMessageToManager({ type, room_slug, timer: globalResult.timer });
        // console.timeEnd('ActionLoop');
        return true;
    }

    async processPlayerRatings(meta, players, storedPlayerRatings) {

        //add saved ratings to players in openskill format
        storedPlayerRatings = storedPlayerRatings || {};
        let playerRatings = {};
        for (var id in players) {
            let player = players[id];

            if (!(id in storedPlayerRatings)) {
                storedPlayerRatings[id] = await r.findPlayerRating(id, meta.game_slug);
            }
            if ((typeof player.rank === 'undefined')) {
                console.error("Player [" + id + "] (" + player.name + ") is missing rank")
                return;
            }

            let playerRating = storedPlayerRatings[id];
            playerRating.rank = player.rank;
            if ((typeof player.score !== 'undefined')) {
                playerRating.score = player.score;
            }
            playerRatings[id] = playerRating;
        }

        console.log("Before Rating: ", playerRatings);

        //run OpenSkill rating system
        rank.calculateRanks(playerRatings);

        //update player ratings from openskill mutation of playerRatings
        let ratingsList = [];
        for (var id in players) {
            let player = players[id];

            if (!(id in playerRatings)) {
                continue;
            }
            let rating = playerRatings[id];
            player.rating = rating.rating;
            player.mu = rating.mu;
            player.sigma = rating.sigma;

            ratingsList.push({
                shortid: id,
                game_slug: meta.game_slug,
                rating: rating.rating,
                mu: rating.mu,
                sigma: rating.sigma
            });
        }

        r.updateAllPlayerRatings(ratingsList);

        console.log("After Rating: ", storedPlayerRatings);
    }


    async sendMessageToManager(msg) {
        if (msg.type == 'update' || msg.type == 'finish' || msg.type == 'error')
            parentPort.postMessage(msg);

    }

    runScript(script) {
        if (!script) {
            console.error("Game script is not loaded.");
            return false;
        }

        try {
            console.time('Game Logic');
            {
                vm.run(script);
            }
            console.timeEnd('Game Logic', 100);
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
        // roomState.prev = {};
        roomState.events = {};

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

        if (action.type == 'join' || action.type == 'leave') {
            let playerList = Object.keys(roomState.players);

            try {
                r.updateRoomPlayerCount(room_slug, playerList.length);
            }
            catch (e) {
                console.error(e);
            }
        }
        cache.set(room_slug, roomState, 6000);
    }


    async downloadGameJS(key, meta) {

        // if (key in this.games)
        //     return this.games[key];

        var js = await s3.downloadServerScript(key, meta);

        var script = new VMScript(js);

        this.games[key] = { script };
        return this.games[key];
    }

    async downloadGameDatabase(key, meta) {

        // if (key in this.databases)
        //     return this.databases[key];

        var json = await s3.downloadServerScript(key, meta);

        this.databases[key] = { db: JSON.parse(json) };
        return this.databases[key];
    }


    async onClose() {

    }

    onException(err) {
        console.error('Asynchronous error caught.', err);
    }

}


module.exports = new FSGWorker();
const { workerData, parentPort } = require("worker_threads")
const fs = require('fs');
const { VM, VMScript, NodeVM } = require('vm2');

const profiler = require('fsg-shared/util/profiler')
const redis = require('fsg-shared/services/redis');
const NodeCache = require("node-cache");

const ObjectStorageService = require("fsg-shared/services/objectstorage");
const s3 = new ObjectStorageService();

const RoomService = require('fsg-shared/services/room');
const r = new RoomService();

var Queue = require('queue-fifo');

const cache = require('fsg-shared/services/cache');

// const { version } = require("os");

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
            //globalResult.meta = globalAction.meta;
        }
        catch (e) {
            console.error(e);
        }
    },
    game: () => cloneObj(globalRoomState),
    action: () => cloneObj(globalAction),
    killGame: () => {
        globalDone = true;
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
        this.roomStates = {};
        this.roomCache = new NodeCache({ stdTTL: 300, checkperiod: 150 });

        this.start();
    }

    async onAction(msg) {

        if (!msg.type) {
            console.error("Not an action: ", msg);
            return;
        }

        let game_slug = msg.meta.game_slug;
        let room_slug = msg.meta.room_slug;
        let version = msg.meta.version;

        if (!game_slug || !room_slug)
            return;

        let key = msg.meta.gameid + '/server.bundle.' + version + '.js';

        try {
            let script = await this.downloadGameJS(key);
            if (!script) {
                console.error("Script unable to be created for: ", msg);
            }
        } catch (e) {
            console.error("Error: Script unable to be created for: ", msg);
            console.log('Error:', e);
        }


        if (msg.type == 'join') {

        }

        console.log("Action Queued: ", msg);
        this.actions.enqueue(msg);
    }

    async start() {
        try {

            await redis.connect(redisCred);

            parentPort.on('message', this.onAction.bind(this));
            parentPort.on('close', this.onClose.bind(this));
            parentPort.postMessage({ status: "READY" });
            process.on('uncaughtException', this.onException)

            while (true) {

                if (this.actions.size() == 0) {
                    await sleep(20);
                    continue;
                }

                this.mainLoop();
            }
        }
        catch (e) {
            console.error(e);
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
        let peeked = this.actions.peek();

        let action = this.actions.dequeue();
        if (!action.meta.game_slug) {
            return;
        }
        let key = action.meta.gameid + '/server.bundle.' + action.meta.version + '.js';
        let game = await this.getGame(key);
        if (!game) {
            this.actions.enqueue(action);
            return;
        }

        this.runAction(action, game);
    }

    async onPlayerJoin(action) {
        let id = action.user.id;
        let name = action.user.name;
        let room_slug = action.meta.room_slug;

        if (!id) {
            console.error("Invalid player: " + id);
            return;
        }


        let roomState = globalRoomState;//let roomState = await this.getRoomState(room_slug);
        if (!(id in roomState.players)) {
            roomState.players[id] = { name }
            r.assignPlayerRoom(id, room_slug);
        }
        else {
            roomState.players[id].name = name;
        }

        this.saveRoomState(room_slug, roomState);

        parentPort.postMessage({ type: 'join', payload: { id, room_slug } });
    }

    async runAction(action, game) {

        let meta = action.meta;


        globalRoomState = await this.getRoomState(meta.room_slug);

        switch (action.type) {
            case 'join':
                await this.onPlayerJoin(action);
                break;
            case 'leave':
                await r.removePlayerRoom()
                break;
            case 'reset':
                globalRoomState = this.makeGame(false, globalRoomState);
                break;
        }

        globalAction = action;
        delete action['meta'];

        this.runScript(game);

        if (typeof globalDone !== 'undefined' && globalDone) {
            globalResult.killGame = true;
            globalDone = false;
        }

        this.saveRoomState(meta.room_slug, globalResult);

        let type = 'update';
        if (globalResult.killGame == true)
            type = 'finish';

        parentPort.postMessage({ type, meta, payload: globalResult });
    }

    runScript(script) {
        if (!script) {
            console.error("Game script is not loaded.");
            return;
        }

        try {
            profiler.StartTime('Game Logic');
            {
                vm.run(script);
            }
            profiler.EndTime('Game Logic', 100);
        }
        catch (e) {
            console.error(e);
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

    saveRoomState(room_slug, roomState) {

        let key = room_slug + '/meta';

        //this.roomStates[room_slug] = roomState;

        let playerList = Object.keys(roomState.players);
        let roomMeta = cache.get(key) || 0;
        //let roomMeta = this.roomCache.get(key) || {};
        roomMeta.player_count = playerList.length;

        cache.set(room_slug, roomState);
        cache.set(key, roomMeta);

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
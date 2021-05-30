const { workerData, parentPort } = require("worker_threads")
const fs = require('fs');
const { VM, VMScript, NodeVM } = require('vm2');

const profiler = require('fsg-shared/util/profiler')
const redis = require('fsg-shared/services/redis');
const NodeCache = require("node-cache");

const ObjectStorageService = require("fsg-shared/services/objectstorage");
const s3 = new ObjectStorageService();

var Queue = require('queue-fifo');
// const { version } = require("os");

var globalGame = null;
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
    game: () => cloneObj(globalGame),
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
        this.rooms = {};
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

    async getRoomData(room_slug) {
        let game = this.rooms[room_slug];
        if (!game) {
            game = await redis.get(room_slug);
        }
        if (!game)
            game = this.makeGame();
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

        if (!(id in globalGame.players)) {
            globalGame.players[id] = { name }
        }
        else {
            globalGame.players[id].name = name;
        }

        parentPort.postMessage({ type: 'join', payload: { id, room_slug } });
    }

    async runAction(action, game) {

        let meta = action.meta;


        globalGame = await this.getRoomData(meta.room_slug);

        switch (action.type) {
            case 'join':
                this.onPlayerJoin(action);
                break;
            case 'reset':
                this.makeGame();
                break;
        }

        globalAction = action;
        delete action['meta'];

        this.runScript(game);
        this.saveRoomData(meta, globalResult);

        if (typeof globalDone !== 'undefined' && globalDone) {
            globalResult.killGame = true;
            this.makeGame(true);
            globalDone = false;
        }

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

    makeGame(clearPlayers) {
        if (!globalGame)
            globalGame = {};
        if (globalGame.killGame) {
            delete globalGame['killGame'];
        }
        globalGame.state = {};
        globalGame.rules = {};
        globalGame.next = {};
        globalGame.prev = {};
        globalGame.events = [];

        if (clearPlayers) {
            globalGame.players = {}
        }
        else {
            let newPlayers = {};
            for (var id in globalGame.players) {
                let player = globalGame.players[id];
                newPlayers[id] = {
                    name: player.name
                }
            }
            globalGame.players = newPlayers;
        }
        return globalGame;
    }

    saveRoomData(meta, game) {

        let room_slug = meta.room_slug;
        let key = room_slug + '/meta';

        let playerList = Object.keys(game.players);
        let roomMeta = this.roomCache.get(key) || {};
        roomMeta.player_count = playerList.length;

        this.roomCache.set(meta.room_slug, game)
        redis.set(meta.room_slug, game);

        this.roomCache.set(key, roomMeta);
        redis.set(key, roomMeta);


        // this.gameHistory.push(game);
        globalGame = JSON.parse(JSON.stringify(globalResult));
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
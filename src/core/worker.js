const { workerData, parentPort } = require("worker_threads")
const fs = require('fs');
const { VM, VMScript, NodeVM } = require('vm2');

const profiler = require('fsg-shared/util/profiler')
const redis = require('fsg-shared/services/redis');
const NodeCache = require("node-cache");

var Queue = require('queue-fifo');
const { version } = require("os");

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


const index = workerData.index;
const redisCred = workerData.redisCred;


class FSGWorker {
    constructor() {
        this.actions = new Queue();
        this.gameHistory = [];
        this.games = {};
        this.rooms = {};
        this.roomCache = new NodeCache({ stdTTL: 300, checkperiod: 150 });
    }

    async onAction(msg) {

        if (!msg.action || !msg.action.type) {
            console.error("Not an action: ", msg);
            return;
        }

        let game_slug = msg.game_slug;
        let room_slug = msg.room_slug;
        let version = msg.version;

        if (!game_slug || !room_slug)
            return;

        let key = game_slug + '/' + version;

        try {
            let script = await this.downloadGameJS(msg);
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

            parentPort.on('message', onMessage);
            parentPort.on('close', onClose);
            parentPort.postMessage({ status: "READY" });
            process.on('uncaughtException', onException)

            while (true) {

                if (this.actions.size() == 0) {
                    await sleep(20);
                    continue;
                }

                mainLoop();
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
        globalGame = this.rooms[room_slug];
        if (!globalGame) {
            globalGame = await redis.get(room_slug);
        }
        if (!globalGame)
            this.makeGame();
        return globalGame;
    }

    async mainLoop() {
        let peeked = this.actions.peek();

        let action = this.actions.dequeue();
        if (!action.game_slug) {
            return;
        }

        let game = await this.getGame(peeked.game_slug, peeked.version);
        if (!game) {
            this.actions.enqueue(action);
            return;
        }

        this.runAction(action, game);
    }

    async onPlayerJoin(action) {
        let userid = action.userid;
        let room_slug = action.room_slug;
        let displayname = action.payload.displayname;
        if (!userid) {
            console.error("Invalid player: " + userid);
            return;
        }

        if (!(userid in globalGame.players)) {
            globalGame.players[userid] = {
                name: displayname
            }
        }
        else {
            globalGame.players[userid].name = displayname;
        }

        parentPort.postMessage({ type: 'join', payload: { userid, room_slug } });
    }

    async runAction(action, game) {

        globalGame = await this.getRoomData(action.room_slug);

        switch (action.type) {
            case 'join':
                this.onPlayerJoin(action);
                break;
            case 'reset':
                this.makeGame();
                break;
        }

        globalAction = action;

        this.runScript(game.script);
        this.saveRoomData(globalResult);

        if (typeof globalDone !== 'undefined' && globalDone) {
            globalResult.killGame = true;
            this.makeGame(true);
            globalDone = false;
        }

        parentPort.postMessage({ type: 'update', payload: globalResult });
    }

    runScript(script) {
        if (!script) {
            console.error("Game script is not loaded.");
            return;
        }

        try {
            profiler.Start('Game Logic');
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
            for (var userid in globalGame.players) {
                let player = globalGame.players[userid];
                newPlayers[userid] = {
                    name: player.username
                }
            }
            globalGame.players = newPlayers;
        }

    }

    saveRoomData(game) {

        let room_slug = game.room_slug;
        let key = room_slug + '/meta';

        let playerList = Object.keys(game.players);
        this.roomCache.set(game.room_slug, { game })

        let roomMeta = this.roomCache.get(key);
        roomMeta.player_count = playerList.length;
        this.roomCache.set(key, roomMeta);

        this.gameHistory.push(game);
        globalGame = JSON.parse(JSON.stringify(globalResult));
    }


    async downloadGameJS(msg) {

        let key = msg.game_slug + '/' + msg.version;
        if (key in this.games)
            return;

        let filepath = './src/core/example.js';
        var data = fs.readFileSync(filepath, 'utf8');
        var script = new VMScript(data);

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
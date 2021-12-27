const { VM, VMScript, NodeVM } = require('vm2');
const rabbitmq = require('fsg-shared/services/rabbitmq');
const room = require('fsg-shared/services/room');
const storage = require('./storage');
const gametimer = require('./gametimer');
const rank = require('./rank');
const delta = require('fsg-shared/util/delta');
const profiler = require('fsg-shared/util/profiler');
const events = require('./events');

// const { version } = require("os");
var globalDatabase = null;
var globalRoomState = null;
var globalAction = {};
var globalResult = null;
var globalDone = null;
var globalErrors = [];
var globalIgnore = false;

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
    },
    ignore: () => {
        globalIgnore = true;
    }
};

const vm = new VM({
    console: false,
    wasm: false,
    eval: false,
    fixAsync: false,
    timeout: 100,
    sandbox: { globals },
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function cloneObj(obj) {
    //if (typeof obj === 'object')
    try {
        return JSON.parse(JSON.stringify(obj));
    }
    catch (e) {
        return null;
    }

    //return obj;
}



class GameRunner {

    async killRoom(action, game, meta) {
        storage.clearRoomDeadline(action.room_slug);
        let key = meta.game_slug + '/' + action.room_slug;

        // let roomState = await storage.getRoomState(room_slug);
        // let players = roomState?.players;
        // if( players ) {
        //     for(var i=0; i<)
        // }

        for (var i = 0; i < globalErrors.length; i++) {
            let error = globalErrors[i];

            storage.addError(meta.gameid, meta.version, error);
        }

        rabbitmq.unsubscribe('game', key, storage.getQueueKey());
    }

    async runAction(action, game, meta) {
        // profiler.StartTime("GameRunner.runAction");

        if (action.type == 'noshow') {
            let outMessage = { type: 'noshow', room_slug: action.room_slug, payload: { error: "Some players did not show up." } };
            rabbitmq.publish('ws', 'onRoomUpdate', outMessage);
            this.killRoom(action, game, meta);
            return false;
        }

        let passed = await this.runActionEx(action, game, meta);
        if (!passed) {
            let outMessage = { type: 'error', room_slug: action.room_slug, payload: { error: "Game crashed. Please report bug." } };
            rabbitmq.publish('ws', 'onRoomUpdate', outMessage);
            this.killRoom(action, game, meta);
        }
        storage.processActionRate();
        // let aps = storage.calculateActionRate();
        // console.log("Actions Per Second = " + aps);
        // profiler.EndTime("GameRunner.runAction");
        return passed;
    }

    async runActionEx(action, game, meta) {
        // console.log('runAction', action);
        let room_slug = meta.room_slug;
        globalRoomState = await storage.getRoomState(room_slug);
        globalIgnore = false;
        let previousRoomState = cloneObj(globalRoomState);

        // if (globalRoomState.join)
        //     delete globalRoomState['join'];
        // if (globalRoomState.leave)
        //     delete globalRoomState['leave'];
        if (globalRoomState.events)
            globalRoomState.events = {};



        try {
            switch (action.type) {
                case 'ready':
                    await this.onPlayerReady(action);
                    break;
                case 'gamestart':
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    if (globalRoomState.state)
                        globalRoomState.state.gamestart = true;
                    break;
                case 'join':
                    await this.onPlayerJoin(action);
                    break;
                case 'leave':
                    await room.removePlayerRoom(action.user.id, room_slug)
                    break;
                case 'reset':
                    globalRoomState = storage.makeGame(false, globalRoomState);
                    break;
            }
        }
        catch (e) {
            console.error(e);
            return false;
        }

        let timeleft = gametimer.calculateTimeleft(globalRoomState);
        if (globalRoomState.timer) {
            action.seq = globalRoomState.timer.seq || 0;
            action.timeleft = timeleft;
        }

        let key = meta.game_slug + '/server.db.' + meta.version + '.json';
        let db = await storage.getGameDatabase(key);

        globalDatabase = db;
        globalAction = [action];

        let succeeded = this.runScript(game);
        if (!succeeded) {
            return false;
        }

        if (globalIgnore) {
            return true;
        }

        console.log("Executed Action: ", action);

        let isGameover = (globalResult.events && globalResult.events.gameover);

        if (globalResult) {
            globalResult = Object.assign({}, globalRoomState, globalResult);
            if (!isGameover)
                gametimer.processTimelimit(globalResult.timer);
            await storage.saveRoomState(action, meta, globalResult);
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

            let players = globalResult?.players;
            let gamestart = globalResult?.state?.gamestart;
            if (!gamestart) {
                globalResult.timer = { set: 5 }
                gametimer.processTimelimit(globalResult.timer);
                gametimer.addRoomDeadline(room_slug, globalResult.timer)
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
        else if (action.type == 'ready') {


            let players = globalResult?.players;
            if (players) {
                let readyCnt = 0;
                let playerCnt = 0;
                for (var id in players) {
                    if (players[id].ready)
                        readyCnt++;
                    playerCnt++;
                }

                if (playerCnt == readyCnt) {
                    events.emitGameStart({ type: 'gamestart', room_slug, payload: null });
                }
            }

        }

        if (isGameover) {
            type = 'finish';
            if (room.getGameModeName(meta.mode) == 'rank') {
                await rank.processPlayerRatings(meta, globalResult.players);
                await room.updateLeaderboard(meta.game_slug, globalResult.players);
            }

        }



        let dlta = delta.delta(previousRoomState, globalResult, {});

        // if (type == 'update' || type == 'finish' || type == 'error') {
        rabbitmq.publish('ws', 'onRoomUpdate', { type, room_slug, payload: dlta });

        if (type == 'update' && globalResult.timer) {
            gametimer.addRoomDeadline(room_slug, globalResult.timer)
        }
        else if (type == 'finish' || type == 'error') {
            this.killRoom(action, game, meta);
        }
        // }
        // profiler.EndTime('WorkerManagerLoop');
        // this.sendMessageToManager({ type, room_slug, timer: globalResult.timer });
        // console.timeEnd('ActionLoop');
        return true;
    }


    runScript(script) {
        if (!script) {
            console.error("Game script is not loaded.");
            globalErrors = [{ "error": "Game script is not loaded.", payload: null }]
            return false;
        }

        try {
            profiler.StartTime('Game Logic');
            {
                vm.run(script);
            }
            profiler.EndTime('Game Logic', 50);
            return true;
        }
        catch (e) {
            console.error("runScript Error: ", e);
            let stack = e.stack;
            stack = stack.replace(e.name + ': ' + e.message + '\n', '');
            let parts = stack.split('\n');
            let body = '';
            for (var i = 0; i < parts.length; i++) {
                let part = parts[i];
                if (part.trim().length == 0)
                    continue;
                if (part.indexOf('vm.js') == -1)
                    continue;
                if (body.length > 0)
                    body += '\n';
                body += part;
            }
            globalErrors = [{
                type: e.name,
                title: e.message,
                body
            }]
            return false;
        }
    }

    async onPlayerReady(action) {
        let id = action.user.id;
        let name = action.user.name;
        let ready = true;
        if (!(id in globalRoomState.players)) {
            globalRoomState.players[id] = { name, rank: 0, score: 0, ready }
            room.assignPlayerRoom(id, room_slug, action.game_slug);
        }
        else {
            globalRoomState.players[id].ready = ready;
        }


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
            globalRoomState.players[id] = { name, rank: 0, score: 0 }
            room.assignPlayerRoom(id, room_slug, action.game_slug);
        }
        else {
            globalRoomState.players[id].name = name;
        }

        //this.saveRoomState(room_slug, roomState);
        // this.mq.publish('ws', 'onJoinResponse', { type: 'join', payload: { id, room_slug } });
        // parentPort.postMessage({ type: 'join', payload: { id, room_slug } });
    }


}

module.exports = new GameRunner();
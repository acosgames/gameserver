const { VM, VMScript, NodeVM } = require('vm2');
const rabbitmq = require('fsg-shared/services/rabbitmq');
const room = require('fsg-shared/services/room');
const storage = require('./storage');
const gametimer = require('./gametimer');
const rank = require('./rank');
const delta = require('fsg-shared/util/delta');
const profiler = require('fsg-shared/util/profiler');
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
    timeout: 100,
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



class GameRunner {

    async runAction(action, game, meta) {
        // profiler.StartTime("GameRunner.runAction");
        let passed = await this.runActionEx(action, game, meta);
        if (!passed) {
            let outMessage = { type: 'error', room_slug: action.room_slug, payload: { error: "Game crashed. Please report bug." } };
            rabbitmq.publish('ws', 'onRoomUpdate', outMessage);
            storage.clearRoomDeadline(room_slug);
            // this.sendMessageToManager(outMessage);

        }
        // profiler.EndTime("GameRunner.runAction");
        return passed;
    }

    async runActionEx(action, game, meta) {
        // console.log('runAction', action);
        let room_slug = meta.room_slug;
        globalRoomState = await storage.getRoomState(room_slug);
        let previousRoomState = cloneObj(globalRoomState);

        // if (globalRoomState.join)
        //     delete globalRoomState['join'];
        // if (globalRoomState.leave)
        //     delete globalRoomState['leave'];
        if (globalRoomState.events)
            globalRoomState.events = {};



        try {
            switch (action.type) {
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

        let key = meta.gameid + '/server.db.' + meta.version + '.json';
        let db = await storage.getGameDatabase(key);

        globalDatabase = db;
        globalAction = [action];

        let succeeded = this.runScript(game);
        if (!succeeded) {
            return false;
        }
        let isGameover = (globalResult.events && globalResult.events.gameover);

        if (globalResult) {
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
            await rank.processPlayerRatings(meta, globalResult.players);
        }



        let dlta = delta.delta(previousRoomState, globalResult, {});

        // if (type == 'update' || type == 'finish' || type == 'error') {
        rabbitmq.publish('ws', 'onRoomUpdate', { type, room_slug, payload: dlta });

        if (type == 'update' && globalResult.timer) {
            gametimer.addRoomDeadline(room_slug, globalResult.timer)
        }
        else if (type == 'finish' || type == 'error') {
            storage.clearRoomDeadline(room_slug);
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
            return false;
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
            globalRoomState.players[id] = { name }
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
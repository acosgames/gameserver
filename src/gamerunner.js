const { VM, VMScript, NodeVM } = require('vm2');
const rabbitmq = require('shared/services/rabbitmq');
const room = require('shared/services/room');
const storage = require('./storage');
const gametimer = require('./gametimer');
const rank = require('./rank');
const delta = require('shared/util/delta');
const profiler = require('shared/util/profiler');
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
        return globalDatabase?.db || null;
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
        try {
            storage.removeTimer(action.room_slug);
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
        catch (e) {

        }

    }

    async runAction(action, game, meta) {
        // profiler.StartTime("GameRunner.runAction");
        let passed = false;
        try {
            if (action.type == 'noshow') {
                let outMessage = { type: 'noshow', room_slug: action.room_slug, payload: { events: { noshow: true } } };
                rabbitmq.publish('ws', 'onRoomUpdate', outMessage);
                this.killRoom(action, game, meta);
                return false;
            }

            passed = await this.runActionEx(action, game, meta);
            if (!passed) {
                let outMessage = { type: 'error', room_slug: action.room_slug, payload: { events: { error: "Game crashed. Please report." } } };
                rabbitmq.publish('ws', 'onRoomUpdate', outMessage);
                this.killRoom(action, game, meta);
            }
            storage.processActionRate();
        }
        catch (e) {
            console.error(e);
        }

        // let aps = storage.calculateActionRate();
        // console.log("Actions Per Second = " + aps);
        // profiler.EndTime("GameRunner.runAction");
        return passed;
    }

    async runActionEx(action, game, meta) {
        console.log('runAction', action);
        let room_slug = meta.room_slug;
        globalRoomState = await storage.getRoomState(room_slug);
        globalIgnore = false;
        let previousRoomState = cloneObj(globalRoomState);

        if (!globalRoomState)
            return false;

        if (globalRoomState?.events?.gameover) {
            return true;
        }

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
                case 'pregame':
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    if (globalRoomState.state)
                        globalRoomState.state.gamestatus = 'pregame';
                    break;
                case 'starting':
                    if (globalRoomState.state)
                        globalRoomState.state.gamestatus = 'starting';
                    break;
                case 'gamestart':
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    if (globalRoomState.state)
                        globalRoomState.state.gamestatus = 'gamestart';
                    break;
                case 'gameover':
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    if (globalRoomState.state)
                        globalRoomState.state.gamestatus = 'gameover';
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
                case 'skip':
                    break;
                default:
                    if (action?.user?.id && globalRoomState?.timer?.seq != action.seq) {
                        //user must use the same sequence as the script
                        console.log("User out of sequence: ", action.user, globalRoomState?.timer?.seq, action.seq);
                        return false;
                    }
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

        console.log("Executed Action: ", action.type, action.room_slug, action.user?.id);

        let isGameover = (globalResult.events && globalResult.events.gameover);

        if (globalResult) {

            //don't allow users to override the status
            if (globalResult.state) {
                globalResult.state.gamestatus = globalRoomState.state.gamestatus;
            }
            globalResult = Object.assign({}, globalRoomState, globalResult);


        }
        let type = 'update';


        if (action.type == 'join') {
            type = 'join';
            if (!globalResult.events)
                globalResult.events = {}

            globalResult.events.join = { id: action.user.id }

            //start the game if its the first player to join room
            let players = globalResult?.players;
            let gamestatus = globalResult?.state?.gamestatus;
            if (!gamestatus) {
                if (globalResult.state) {
                    let playerList = Object.keys(globalResult.players);
                    if (playerList.length == 1) {
                        globalResult.state.gamestatus = 'pregame';
                        globalResult.timer = { set: 60 }
                        gametimer.processTimelimit(globalResult.timer);
                        gametimer.addRoomDeadline(room_slug, globalResult.timer)
                    }

                }

            }
            // globalResult.join = action.user.id;
        }
        else if (action.type == 'leave') {
            type = 'leave';

            if (!globalResult.events)
                globalResult.events = {}

            globalResult.events.leave = { id: action.user.id }

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
                    globalResult.state.gamestatus = 'starting';
                    let startTime = meta.maxplayers == 1 ? 2 : 4;
                    globalResult.timer = { set: startTime }
                    gametimer.processTimelimit(globalResult.timer);
                    gametimer.addRoomDeadline(room_slug, globalResult.timer)

                    // events.emitGameStart({ type: 'gamestart', room_slug, payload: null });
                }
            }

        }
        else {
            if (!isGameover && globalResult.state.gamestatus == 'gamestart') {
                // globalResult.timer.set = 100000;
                gametimer.processTimelimit(globalResult.timer);
                gametimer.addRoomDeadline(room_slug, globalResult.timer)
            }
            else {
                globalRoomState.state.gamestatus = 'gameover';
            }
        }



        if (isGameover) {
            type = 'gameover';
            if (room.getGameModeName(meta.mode) == 'rank') {
                let storedPlayerRatings = {};
                if (globalResult?.timer?.seq > 2) {


                    if (meta.maxplayers > 1) {
                        await rank.processPlayerRatings(meta, globalResult.players, storedPlayerRatings);
                        await room.updateLeaderboard(meta.game_slug, globalResult.players);
                    }



                }

                if (meta.lbscore || meta.maxplayers == 1) {
                    console.log("Updating high scores: ", globalResult.players);
                    await rank.processPlayerHighscores(meta, globalResult.players, storedPlayerRatings);
                    await room.updateLeaderboardHighscore(meta.game_slug, globalResult.players);
                }


            }

        }

        await storage.saveRoomState(action, meta, globalResult);


        let dlta = delta.delta(previousRoomState, globalResult, {});

        // if (type == 'update' || type == 'gameover' || type == 'error') {
        rabbitmq.publish('ws', 'onRoomUpdate', { type, room_slug, payload: dlta });

        if (type == 'update' && globalResult.timer) {

        }
        else if (isGameover || type == 'error') {
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
            // room.assignPlayerRoom(id, room_slug, action.game_slug);
        }
        else {
            globalRoomState.players[id].name = name;
        }
        // let meta = await storage.getRoomMeta(room_slug);




        //this.saveRoomState(room_slug, roomState);
        // this.mq.publish('ws', 'onJoinResponse', { type: 'join', payload: { id, room_slug } });
        // parentPort.postMessage({ type: 'join', payload: { id, room_slug } });
    }


}

module.exports = new GameRunner();
const { VM, VMScript, NodeVM } = require('vm2');
const rabbitmq = require('shared/services/rabbitmq');
const room = require('shared/services/room');
const storage = require('./storage');
const gametimer = require('./gametimer');
const rank = require('./rank');
const delta = require('shared/util/delta');
const profiler = require('shared/util/profiler');
const events = require('./events');
const onJoin = require('../../websocket/src/onJoin');

const DiscreteRandom = require('./DiscreteRandom');

// const { version } = require("os");
var globalDatabase = null;
var globalRoomState = null;
var globalAction = {};
var globalResult = null;
var globalDone = null;
var globalErrors = [];
var globalIgnore = false;

var globalSkipCount = {};

var globals = {
    log: (msg) => { console.log(msg) },
    error: (msg) => { console.error(msg) },
    finish: (newGame) => {
        try {
            console.log("FINISHED: ", newGame);
            globalResult = cloneObj(newGame);
        }
        catch (e) {
            console.error(e);
        }
    },
    random: () => { return DiscreteRandom.random(); },
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

    async killRoom(room_slug, meta) {
        try {
            storage.removeTimer(room_slug);
            let key = meta.game_slug + '/' + room_slug;

            // let roomState = await storage.getRoomState(room_slug);
            // let players = roomState?.players;
            // if( players ) {
            //     for(var i=0; i<)
            // }

            for (var i = 0; i < globalErrors.length; i++) {
                let error = globalErrors[i];

                storage.addError(meta.game_slug, meta.version, error);
            }

            rabbitmq.unsubscribe('game', key, storage.getQueueKey());
        }
        catch (e) {

        }

    }

    async runAction(incomingActions, gameScript, meta) {
        // profiler.StartTime("GameRunner.runAction");
        let passed = false;
        try {
            let actions = null;
            if (Array.isArray(incomingActions)) {
                actions = incomingActions;
            } else {
                actions = [incomingActions];
            }

            let isGameover = false;
            let finalDelta = null;
            let responseType = 'join';
            let joinIds = [];


            globalRoomState = await storage.getRoomState(meta.room_slug);
            let previousRoomState = cloneObj(globalRoomState);

            //create new game
            if (!globalRoomState) {
                previousRoomState = {};
                globalRoomState = storage.makeGame(meta);
                await storage.saveRoomState('newgame', meta, globalRoomState);

            }


            if (globalRoomState.events)
                globalRoomState.events = {};



            for (let action of actions) {

                if (action.type != 'join' && action.type != 'leave' && action.type != 'ready' && action?.user?.id && globalRoomState?.timer?.sequence != action.timeseq) {
                    //user must use the same sequence as the script
                    console.log("User out of sequence: ", action.user, globalRoomState?.timer?.sequence, action.timeseq);
                    return true;
                }

                if (action.type == 'noshow') {
                    let outMessage = { type: 'noshow', room_slug: action.room_slug, payload: { events: { noshow: true } } };
                    rabbitmq.publish('ws', 'onRoomUpdate', outMessage);
                    this.killRoom(meta.room_slug, meta);
                    return false;
                }

                passed = await this.runActionEx(action, gameScript, meta);
                if (!passed) {
                    let outMessage = { type: 'error', room_slug: action.room_slug, payload: { events: { error: "Game crashed. Please report." } } };
                    rabbitmq.publish('ws', 'onRoomUpdate', outMessage);
                    this.killRoom(meta.room_slug, meta);
                    return false;
                } else {
                    if (passed.isGameover || passed.type == 'error') {
                        await storage.saveRoomState(responseType, meta, globalResult);
                        let deltaState = delta.delta(previousRoomState, globalResult, {});
                        rabbitmq.publish('ws', 'onRoomUpdate', { type: passed.type, room_slug: action.room_slug, payload: deltaState });
                        this.killRoom(meta.room_slug, meta);
                        return false;
                    }

                    responseType = passed.type;
                    globalRoomState = cloneObj(globalResult);
                }
            }

            if (responseType == 'join' && globalRoomState.players) {
                for (const shortid in globalRoomState.players) {
                    joinIds.push(shortid)
                }
                globalResult.events.join = joinIds;
            }

            await storage.saveRoomState(responseType, meta, globalResult);

            previousRoomState.events = {};

            console.log("GLOBALRESULT = ", JSON.stringify(globalResult))
            let deltaState = delta.delta(previousRoomState, globalResult, {});

            if (actions.length == 1)
                deltaState.action = actions[0];
            else
                deltaState.action = actions;

            rabbitmq.publish('ws', 'onRoomUpdate', { type: responseType, room_slug: meta.room_slug, payload: deltaState });

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

    async runActionEx(action, gameScript, meta) {
        console.log('runAction', action);
        let room_slug = meta.room_slug;

        globalIgnore = false;


        if (!globalRoomState)
            return false;

        if (globalRoomState?.room?.status == 'gameover') {
            return false;
        }


        globalRoomState.room = {
            room_slug: meta.room_slug,
            sequence: globalRoomState?.room?.sequence || 0,
            status: globalRoomState?.room?.status || 'pregame',
            starttime: globalRoomState?.room?.starttime || Date.now(),
            endtime: 0,
            updated: Date.now()
        }

        // if (globalRoomState.join)
        //     delete globalRoomState['join'];
        // if (globalRoomState.leave)
        //     delete globalRoomState['leave'];




        try {
            switch (action.type) {
                case 'ready':
                    this.onPlayerReady(action);
                    break;
                case 'pregame':
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    globalRoomState.room.status = 'pregame';
                    break;
                case 'starting':
                    // if (globalRoomState.state)
                    globalRoomState.room.status = 'starting';
                    break;
                case 'gamestart':
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    globalRoomState.room.status = 'gamestart';
                    break;
                case 'gameover':
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    globalRoomState.room.status = 'gameover';
                    break;
                case 'join':
                    this.onPlayerJoin(action);
                    break;
                case 'leave':
                    let players = globalRoomState.players || {};
                    let player = players[action.user.id]
                    if (player) {
                        player.ingame = false;
                    }
                    room.removePlayerRoom(action.user.id, room_slug)
                    break;
                // case 'reset':
                //     globalRoomState = storage.makeGame(false, globalRoomState);
                //     break;
                case 'skip':
                    if (!(room_slug in globalSkipCount))
                        globalSkipCount[room_slug] = 0
                    globalSkipCount[room_slug]++;

                    if (globalSkipCount[room_slug] > 5) {
                        console.log("Too many skips: ", action);
                        return false;
                    }
                    break;
                default:
                    if (action?.user?.id && globalRoomState?.timer?.sequence != action.timeseq) {
                        //user must use the same sequence as the script
                        console.log("User out of sequence: ", action.user, globalRoomState?.timer?.sequence, action.timeseq);
                        return false;
                    }
                    break;
            }
        }
        catch (e) {
            console.error(e);
            return false;
        }

        if (action.type != 'skip') {
            delete globalSkipCount[room_slug];
        }

        let seedStr = meta.room_slug + globalRoomState.room.starttime + globalRoomState.room.sequence;
        DiscreteRandom.seed(seedStr)


        let success = await this.executeScript(gameScript, action, meta);
        if (!success)
            return false;

        let isGameover = (delta.isObject(globalResult) && ('events' in globalResult) && ('gameover' in globalResult.events));
        console.log('isGameover: ', isGameover, globalResult.events);

        let responseType = 'update';


        if (action.type == 'join') {
            responseType = 'join';
            this.onJoin(room_slug, action);
        }
        else if (action.type == 'leave') {
            responseType = 'leave';
            this.onLeave(action);

        }
        else if (action.type == 'ready') {
            this.onReady(meta);
        }
        else {
            if (!isGameover) {
                // globalResult.timer.set = 100000;
                gametimer.processTimelimit(globalResult.timer);
                gametimer.addRoomDeadline(room_slug, globalResult.timer)
            }
            else {
                globalResult.room.status = 'gameover';
            }
        }


        if (isGameover) {
            responseType = 'gameover';
            await this.onGameover(meta);
        }





        // profiler.EndTime('WorkerManagerLoop');
        // console.timeEnd('ActionLoop');
        return { type: responseType, isGameover };
    }

    async executeScript(gameScript, action, meta) {

        //add timeleft to the action for games to use
        let timeleft = gametimer.calculateTimeleft(globalRoomState);
        if (globalRoomState.timer) {
            action.timeseq = globalRoomState.timer.sequence || 0;
            action.timeleft = timeleft;
        }

        //add the game database into memory
        let key = meta.game_slug + '/server.db.' + meta.version + '.json';
        let db = await storage.getGameDatabase(key);
        // console.log("database key", key, meta.game_slug);
        // console.log("database", db);


        globalDatabase = db;
        globalAction = [action];

        //run the game server script
        let succeeded = this.runScript(gameScript);
        if (!succeeded) {
            return false;
        }

        if (globalIgnore) {
            return true;
        }

        console.log("Executed Action: ", action.type, action.room_slug, action.user?.id);


        if (globalResult) {

            globalResult.room = {
                room_slug: meta.room_slug,
                sequence: (globalRoomState?.room?.sequence || 0) + 1,
                status: globalRoomState?.room?.status || 'pregame',
                starttime: globalRoomState?.room?.starttime || Date.now(),
                endtime: 0,
                updated: Date.now()
            }

            globalResult.timer = globalResult.timer || {};
            globalResult.timer.sequence = globalRoomState.sequence;
            globalResult.timer.end = globalRoomState.end;
            globalResult.timer.seconds = globalRoomState.seconds;



            // globalResult.action = action;




            // //don't allow users to override the room status
            // if (globalResult.state) {
            //     globalResult.room.status = globalRoomState.room.status;
            // }

            //tag the state with time it was processed
            // globalResult.timer.lastUpdate = globalResult.timer.end - action.timeleft

            //merge result into room state
            globalResult = Object.assign({}, globalRoomState, globalResult);


        }

        return true;
    }

    addEvent(type, payload) {
        if (!globalResult.events)
            globalResult.events = {}

        let events = globalResult.events
        let event = events[type];
        if (!(type in events)) {
            event = payload;
        }
        else if (!Array.isArray(event)) {
            event = [event];
        }
        else {
            event.push(payload);
        }

        globalResult.events[type] = event;
    }

    onLeave(action) {
        this.addEvent('leave', { id: action.user.id });
        let players = globalResult?.players;
        let player = players[action.user.id]
        if (player) {
            player.ingame = false;
        }
    }
    onJoin(room_slug, action) {

        // if (!globalResult.events)
        //     globalResult.events = {}

        // globalResult.events.join = { id: action.user.id }

        //start the game if its the first player to join room
        let players = globalResult?.players;
        let roomstatus = globalResult?.room?.status;
        if (!roomstatus) {
            if (globalResult.state) {
                let playerList = Object.keys(players);
                if (playerList.length == 1) {
                    globalResult.room.status = 'pregame';
                    globalResult.timer = { ...globalResult.timer, set: 60 }
                    gametimer.processTimelimit(globalResult.timer);
                    gametimer.addRoomDeadline(room_slug, globalResult.timer)
                }

            }

        }
    }
    onReady(meta) {
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
                globalResult.room.status = 'starting';



                if (meta.maxplayers == 1) {
                    events.emitGameStart({ type: 'gamestart', room_slug: meta.room_slug, payload: null });
                }
                else {
                    let startTime = 3;
                    globalResult.timer = { ...globalResult.timer, set: startTime }
                    gametimer.processTimelimit(globalResult.timer);
                    gametimer.addRoomDeadline(meta.room_slug, globalResult.timer)
                }
            }
        }
    }

    async onGameover(meta) {

        console.log("GAMEOVER: ", meta, globalResult)
        if (room.getGameModeName(meta.mode) == 'rank' || meta.mode == 'rank') {
            let storedPlayerRatings = {};
            if (globalResult?.timer?.sequence > 2) {
                if (meta.maxplayers > 1) {
                    await rank.processPlayerRatings(meta, globalResult.players, globalResult.teams, storedPlayerRatings);
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

    onPlayerReady(action) {
        let id = action.user.id;
        let name = action.user.displayname;
        let ready = true;
        if (!(id in globalRoomState.players)) {
            globalRoomState.players[id] = { name, rank: 0, score: 0, ready }

        }
        else {
            globalRoomState.players[id].ready = ready;
        }


    }

    onPlayerJoin(action) {
        let id = action.user.id;
        let name = action.user.displayname;
        let room_slug = action.room_slug;
        let team_slug = action.user.team_slug;

        if (!id) {
            console.error("Invalid player: " + id);
            return;
        }

        if (!(id in globalRoomState.players)) {
            globalRoomState.players[id] = { name, id, rank: 0, score: 0, rating: action.user.rating }
        }
        else {
            globalRoomState.players[id].name = name;
            globalRoomState.players[id].id = id;
        }

        if (team_slug) {

            // if (!globalRoomState.teams) {
            //     globalRoomState.teams = {};
            // }
            if (!(team_slug in globalRoomState.teams)) {
                globalRoomState.teams[team_slug] = { players: [] }
            }

            globalRoomState.teams[team_slug].players.push(action.user.id);
            globalRoomState.players[id].teamid = team_slug;
        }
    }


}

module.exports = new GameRunner();
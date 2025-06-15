// const { VM, VMScript, NodeVM } = require('vm2');
const rabbitmq = require("shared/services/rabbitmq");
const room = require("shared/services/room");
const storage = require("./storage");
const gametimer = require("./gametimer");
const rank = require("./rank");
const delta = require("acos-json-delta");
const profiler = require("shared/util/profiler");
const events = require("./events");

const { isObject } = require("shared/util/utils");

const DiscreteRandom = require("./DiscreteRandom");

// const { version } = require("os");
var globalDatabase = null;
var globalRoomState = null;
var globalAction = {};
var globalResult = null;
var globalDone = null;
var globalErrors = [];
var globalIgnore = false;

var globalSkipCount = {};

var globalRandomFuncs = {};

const ivm = require("isolated-vm");

let isolateOptions = {};
let NODE_ENV = process.env.NODE_ENV;
if (NODE_ENV == "localhost" || NODE_ENV == "mobile")
    isolateOptions = { memoryLimit: 128, inspector: true };
else isolateOptions = { memoryLimit: 1024, inspector: false };
const isolate = new ivm.Isolate(isolateOptions);
// Create a new context within this isolate. Each context has its own copy of all the builtin
// Objects. So for instance if one context does Object.prototype.foo = 1 this would not affect any
// other contexts.
const globals = {
    // globals: new ivm.Reference({
    //     log: (msg) => { console.log(msg) },
    //     error: (msg) => { console.error(msg) },
    //     finish: (newGame) => {
    //         try {
    //             console.log("FINISHED: ", newGame);
    //             globalResult = cloneObj(newGame);
    //         }
    //         catch (e) {
    //             console.error(e);
    //         }
    //     },
    //     random: () => { return DiscreteRandom.random(); },
    //     game: () => cloneObj(globalRoomState),
    //     actions: () => cloneObj(globalAction),
    //     killGame: () => {
    //         globalDone = true;
    //     },
    //     database: () => {
    //         return globalDatabase?.db || null;
    //     },
    //     ignore: () => {
    //         globalIgnore = true;
    //     }

    // }),
    gamelog: function () {
        // var args = Array.from(arguments);
        // console.log.apply(console, args);
        // console.log('GAMERUNNER LOG: ', ...args)
        // return () => { }
    },
    gameerror: function () {
        // var args = Array.from(arguments);
        // console.error(...args);
        // console.error(...args)
        // return () => { }
    },
    save: new ivm.Callback((newGame) => {
        try {
            // console.log("FINISHED: ", newGame);
            globalResult = structuredClone(newGame);
        } catch (e) {
            console.error(e);
        }
    }),
    random: new ivm.Callback(() => {
        try {
            return globalRandomFuncs[globalResult.room.room_slug] || DiscreteRandom.random();
        } catch (e) {
            console.error(e);
        }
    }),
    game: new ivm.Callback(() => {
        return structuredClone(globalRoomState);
    }),
    actions: new ivm.Callback(() => {
        return globalAction;
    }),
    killGame: new ivm.Callback(() => {
        globalDone = true;
    }),
    database: new ivm.Callback(() => {
        return globalDatabase?.db || null;
    }),
    ignore: new ivm.Callback(() => {
        globalIgnore = true;
    }),
};

// var globals = {
//     log: (msg) => { console.log(msg) },
//     error: (msg) => { console.error(msg) },
//     finish: (newGame) => {
//         try {
//             console.log("FINISHED: ", newGame);
//             globalResult = cloneObj(newGame);
//         }
//         catch (e) {
//             console.error(e);
//         }
//     },
//     random: () => { return DiscreteRandom.random(); },
//     game: () => cloneObj(globalRoomState),
//     actions: () => cloneObj(globalAction),
//     killGame: () => {
//         globalDone = true;
//     },
//     database: () => {
//         return globalDatabase?.db || null;
//     },
//     ignore: () => {
//         globalIgnore = true;
//     }
// };

// const vm = new VM({
//     console: false,
//     wasm: false,
//     eval: false,
//     fixAsync: false,
//     timeout: 100,
//     sandbox: { globals },
// });

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function cloneObj(obj) {
    //if (typeof obj === 'object')
    try {
        return structuredClone(obj); // JSON.parse(JSON.stringify(obj));
    } catch (e) {
        return null;
    }

    //return obj;
}

class GameRunner {
    getIsolate() {
        return isolate;
    }

    async killRoom(room_slug, meta) {
        try {
            storage.removeTimer(room_slug);
            let key = meta.game_slug + "/" + room_slug;

            storage.cleanupRoom(meta);
            // let roomState = await storage.getRoomState(room_slug);
            // let players = roomState?.players;
            // if( players ) {
            //     for(var i=0; i<)
            // }

            for (var i = 0; i < globalErrors.length; i++) {
                let error = globalErrors[i];

                storage.addError(meta.game_slug, meta.version, error);
            }

            rabbitmq.unsubscribe("game", key, storage.getQueueKey());
        } catch (e) {}
    }

    async runAction(incomingActions, gameScript, meta) {
        profiler.StartTime("GameRunner.runAction");
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
            let responseType = "join";
            let joinIds = [];

            globalRoomState = await storage.getRoomState(meta.room_slug);
            let previousRoomState = structuredClone(globalRoomState);

            //create new game
            if (!globalRoomState) {
                previousRoomState = {};
                globalRoomState = storage.makeGame(meta);
                await storage.saveRoomState("newgame", meta, globalRoomState);

                let seedStr = meta.room_slug + globalRoomState.room.starttime;
                globalRandomFuncs[meta.room_slug] = DiscreteRandom.seed(seedStr);
            }

            if (!globalRoomState.room?.events) globalRoomState.room.events = {};

            let events = {};

            for (let action of actions) {
                // if (
                //     action.type != "join" &&
                //     action.type != "leave" &&
                //     action.type != "ready" &&
                //     action?.user?.shortid &&
                //     globalRoomState?.timer?.sequence != action.timeseq
                // ) {
                //     //user must use the same sequence as the script
                //     console.log(
                //         "User out of sequence: ",
                //         action.user,
                //         globalRoomState?.timer?.sequence,
                //         action.timeseq
                //     );
                //     continue;
                // }
                //add timeleft to the action for games to use
                let timeleft = gametimer.calculateTimeleft(globalRoomState);
                if (globalRoomState?.room?.timeend) {
                    // action.timeseq = globalRoomState.timer.sequence || 0;
                    action.timeleft = timeleft;
                }

                if (action.type == "noshow") {
                    let outMessage = {
                        type: "noshow",
                        room_slug: action.room_slug,
                        payload: { events: { noshow: true } },
                    };
                    rabbitmq.publish("ws", "onRoomUpdate", outMessage);
                    this.killRoom(meta.room_slug, meta);
                    return false;
                }

                passed = await this.runActionEx(action, gameScript, meta);

                //Error running game's server code
                if (!passed) {
                    let players;
                    if (action.type == "join") {
                        players = {};
                        actions.map((a) => {
                            players[a.user.shortid] = {
                                ...a.user,
                                shortid: a.user.shortid,
                            };
                        });
                    }
                    let outMessage = {
                        type: "error",
                        room_slug: action.room_slug,
                        action,
                        payload: {
                            events: { error: "Game crashed. Please report." },
                            players,
                            room: { status: "gameerror" },
                        },
                    };
                    rabbitmq.publish("ws", "onRoomUpdate", outMessage);
                    this.killRoom(meta.room_slug, meta);
                    return false;
                }

                //player didn't show up (didn't call "ready" action)
                if (passed.type == "noshow") {
                    let outMessage = {
                        type: "noshow",
                        room_slug: action.room_slug,
                        payload: { events: { noshow: true } },
                    };
                    rabbitmq.publish("ws", "onRoomUpdate", outMessage);
                    this.killRoom(meta.room_slug, meta);
                    return false;
                }

                //Gameover and errors
                if (passed.isGameover || passed.type == "error") {
                    await storage.saveRoomState(responseType, meta, globalResult);
                    let deltaState = delta.delta(previousRoomState, globalResult, {});

                    //forward to external watchers that process ratings, stats, achievements, etc.
                    if (passed.isGameover && passed.type == "gameover") {
                        rabbitmq.publish("ws", "onRoomGameover", {
                            type: passed.type,
                            room_slug: action.room_slug,
                            meta,
                            payload: globalResult,
                        });
                    }
                    rabbitmq.publish("ws", "onRoomUpdate", {
                        type: passed.type,
                        room_slug: action.room_slug,
                        payload: deltaState,
                    });
                    this.killRoom(meta.room_slug, meta);
                    return false;
                }

                if (globalResult?.room?.events) {
                    for (let key in globalResult?.room?.events) {
                        if (key in events) {
                            if (!Array.isArray(events[key])) {
                                events[key] = [events[key]];
                            }
                            events[key].push(globalResult?.room?.events[key]);
                        } else {
                            events[key] = globalResult?.room?.events[key];
                        }
                    }
                }

                responseType = passed.type;
                globalRoomState = cloneObj(globalResult);
            }

            globalResult.room.events = events;
            await storage.saveRoomState(responseType, meta, globalResult);

            if (previousRoomState?.room) previousRoomState.room.events = {};

            console.log("GLOBALRESULT = ", JSON.stringify(globalResult));
            let deltaState = delta.delta(previousRoomState, globalResult, {});

            // if (actions.length == 1)
            //     deltaState.action = actions[0];
            // else
            //     deltaState.action = actions;

            rabbitmq.publish("ws", "onRoomUpdate", {
                type: responseType,
                room_slug: meta.room_slug,
                payload: deltaState,
            });

            storage.processActionRate();
        } catch (e) {
            console.error(e);
        }

        // let aps = storage.calculateActionRate();
        // console.log("Actions Per Second = " + aps);
        profiler.EndTime("GameRunner.runAction");
        return passed;
    }

    async runActionEx(action, gameScript, meta) {
        console.log("runAction", action);
        let room_slug = meta.room_slug;

        globalIgnore = false;

        if (!globalRoomState) return false;

        if (
            globalRoomState?.room?.status == "gameover" ||
            globalRoomState?.room?.status == "gamecancelled" ||
            globalRoomState?.room?.status == "gameerror"
        ) {
            return false;
        }

        let prevStatus = globalRoomState?.room?.status;

        globalRoomState.room = {
            room_slug: meta.room_slug,
            sequence: globalRoomState?.room?.sequence || 0,
            status: globalRoomState?.room?.status,
            starttime: globalRoomState?.room?.starttime || Date.now(),
            next_id: globalRoomState?.room?.next_id,
            next_action: globalRoomState?.room?.next_action,
            timesec: globalRoomState?.room?.timesec,
            timeend: globalRoomState?.room?.timeend,
            endtime: 0,
            updated: Date.now(),
        };

        // if (globalRoomState.join)
        //     delete globalRoomState['join'];
        // if (globalRoomState.leave)
        //     delete globalRoomState['leave'];

        try {
            switch (action.type) {
                case "ready":
                    this.onPlayerReady(action);
                    break;
                case "pregame":
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    globalRoomState.room.status = "pregame";
                    break;
                case "starting":
                    // if (globalRoomState.state)
                    globalRoomState.room.status = "starting";
                    break;
                case "gamestart":
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    globalRoomState.room.status = "gamestart";
                    break;
                case "gameover":
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    globalRoomState.room.status = "gameover";
                    break;
                case "gamecancelled":
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    globalRoomState.room.status = "gamecancelled";
                    break;
                case "gameerror":
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    globalRoomState.room.status = "gameerror";
                    break;
                case "join":
                    this.onPlayerJoin(action);
                    break;
                case "leave":
                    let players = globalRoomState.players || {};
                    let player = players[action.user.shortid];
                    if (player) {
                        player.forfeit = true;
                    }
                    // if (meta.maxplayers > 1) room.removePlayerRoom(action.user.shortid, room_slug);
                    break;
                // case 'reset':
                //     globalRoomState = storage.makeGame(false, globalRoomState);
                //     break;
                case "skip":
                    if (!(room_slug in globalSkipCount)) globalSkipCount[room_slug] = 0;
                    globalSkipCount[room_slug]++;

                    if (globalSkipCount[room_slug] > 5) {
                        console.log("Too many skips: ", action);
                        return false;
                    }
                    break;
                default:
                    // if (
                    //     action?.user?.shortid &&
                    //     globalRoomState?.timer?.sequence != action.timeseq
                    // ) {
                    //     //user must use the same sequence as the script
                    //     console.log(
                    //         "User out of sequence: ",
                    //         action.user,
                    //         globalRoomState?.timer?.sequence,
                    //         action.timeseq
                    //     );
                    //     return false;
                    // }
                    break;
            }
        } catch (e) {
            console.error(e);
            return false;
        }

        if (action.type != "skip") {
            delete globalSkipCount[room_slug];
        }

        // let seedStr = meta.room_slug + globalRoomState.room.starttime;
        // globalRandomFuncs[meta.room_slug] = DiscreteRandom.seed(seedStr);

        let success = await this.executeScript(gameScript, action, meta);
        if (!success) return false;

        if (!this.validateGlobalResult()) return false;

        let isGameover = false;

        if (globalResult?.room?.events) {
            if (globalResult.room?.events?.gameover) isGameover = "gameover";
            else if (globalResult.room?.events?.gamecancelled) isGameover = "gamecancelled";
            else if (globalResult.room?.events?.gameerror) isGameover = "gameerror";
        }

        console.log("isGameover: ", isGameover, globalResult.room?.events);

        let responseType = "update";

        if (globalResult?.room) {
            globalResult.room.timeend = globalRoomState.room.timeend;
            globalResult.room.timesec = globalRoomState.room.timesec;
        }

        if (action.type == "join") {
            responseType = "join";
            this.onJoin(room_slug, action);
        } else if (action.type == "leave") {
            responseType = "leave";
            this.onLeave(action);
        } else if (action.type == "ready") {
            this.onReady(meta);
        }

        // if (globalResult?.room?.status != "gamestart")
        if (globalResult) {
            // globalResult.timer.set = 100000;
            let room = {
                room_slug: meta.room_slug,
                events: globalResult?.room?.events,
                // sequence: (globalRoomState?.room?.sequence || 0) + 1,
                status: globalRoomState?.room?.status,
                starttime: globalRoomState?.room?.starttime || Date.now(),
                endtime: 0,
                updated: Date.now() - globalRoomState?.room?.starttime,
                // timeend: globalResult?.room?.timeend,
                // timesec: globalResult?.room?.timesec,
                next_id: globalResult?.room?.next_id,
                next_action: globalResult?.room?.next_action,
            };

            if (globalResult?.timer?.set) {
                let { timeend, timesec } = gametimer.processTimelimit(globalResult);
                gametimer.addRoomDeadline(room_slug, timeend);

                room.timeend = timeend;
                room.timesec = timesec;
            } else {
                room.timeend = globalResult?.room?.timeend;
                room.timesec = globalResult?.room?.timesec;
            }

            //merge result into room state
            globalResult = Object.assign({}, globalRoomState, globalResult);
            globalResult.room = room;
        }

        if (isGameover) {
            if (isGameover) {
                globalResult.room.status = isGameover;
                globalResult.room.endtime = Date.now();
            }
            responseType = isGameover;
            if (prevStatus == "pregame" || prevStatus == "starting") {
                responseType = "noshow";
            } else await this.onGameover(meta);
        }

        // profiler.EndTime('WorkerManagerLoop');
        // console.timeEnd('ActionLoop');
        return { type: responseType, isGameover };
    }

    validateGlobalResult() {
        if (!globalResult) return false;
        if (!globalResult?.players) return false;
        if (!isObject(globalResult?.players)) return false;
        for (let key in globalResult.players) {
            if (!isObject(globalResult.players[key])) return false;
            if (!globalResult.players[key].displayname) return false;
        }
        if (!isObject(globalResult?.room)) return false;

        return true;
    }

    async executeScript(gameScript, action, meta) {
        //add the game database into memory
        let key = meta.game_slug + "/server.db." + meta.version + ".json";
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

        console.log("Executed Action: ", action.type, action.room_slug, action.user?.shortid);

        return true;
    }

    addEvent(type, payload) {
        if (!globalResult.room?.events) globalResult.room.events = {};

        let events = globalResult?.room?.events;
        let event = events[type];
        if (!(type in events)) {
            event = payload;
        } else if (!Array.isArray(event)) {
            event = [event];
        } else {
            event.push(payload);
        }

        globalResult.room.events[type] = event;
    }

    onLeave(action) {
        this.addEvent("leave", { shortid: action.user.shortid });
        let players = globalResult?.players;
        let player = players[action.user.shortid];
        if (player) {
            player.forfeit = true;
        }
    }
    onJoin(room_slug, action) {
        // if (!globalResult.events)
        //     globalResult.events = {}

        // globalResult.events.join = { shortid: action.user.shortid }

        //start the game if its the first player to join room
        let players = globalResult?.players;
        let roomstatus = globalResult?.room?.status;
        if (!roomstatus || roomstatus == "none") {
            // if (!globalResult?.room?.timeend) {
            let playerList = Object.keys(players);
            if (playerList.length == 1) {
                globalResult.room.status = "pregame";
                globalResult.timer = { set: 60 };
                let { timeend, timesec } = gametimer.processTimelimit(globalResult);
                gametimer.addRoomDeadline(room_slug, timeend);

                globalResult.room.timeend = timeend;
                globalResult.room.timesec = timesec;
            }
            // }
        }

        if (!globalResult.room?.events) {
            globalResult.room.events = {};
        }
        globalResult.room.events.join = action.user.shortid;
    }
    onReady(meta) {
        let players = globalResult?.players;
        if (players) {
            let readyCnt = 0;
            let playerCnt = 0;
            for (var shortid in players) {
                if (players[shortid].ready) readyCnt++;
                playerCnt++;
            }

            if (playerCnt == readyCnt) {
                globalRoomState.room.status = "starting";

                if (meta.maxplayers == 1) {
                    events.emitGameStart({
                        type: "gamestart",
                        room_slug: meta.room_slug,
                        payload: null,
                    });
                } else {
                    let startTime = 4;
                    globalResult.timer = {
                        set: startTime,
                    };
                    let { timeend, timesec } = gametimer.processTimelimit(globalResult);
                    gametimer.addRoomDeadline(meta.room_slug, timeend);

                    globalResult.room.timeend = timeend;
                    globalResult.room.timesec = timesec;
                }
            }
        }
    }

    async onGameover(meta) {
        //moving to postGameManager.js
        return;
        console.log("GAMEOVER: ", meta, globalResult);
        if (room.getGameModeName(meta.mode) == "rank" || meta.mode == "rank") {
            let storedPlayerRatings = {};
            if (globalResult?.timer?.sequence > 2) {
                if (meta.maxplayers > 1) {
                    await rank.processPlayerRatings(
                        meta,
                        globalResult.players,
                        globalResult.teams,
                        storedPlayerRatings
                    );
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
            globalErrors = [{ error: "Game script is not loaded.", payload: null }];
            return false;
        }

        try {
            profiler.StartTime("Game Logic");
            {
                // vm.run(script);
                const vmContext = isolate.createContextSync();
                vmContext.global.setSync("global", vmContext.global.derefInto());
                // vmContext.global.setSync('globals', new ivm.Reference(globals));
                vmContext.global.setSync("gamelog", globals.gamelog);
                vmContext.global.setSync("gameerror", globals.gameerror);
                vmContext.global.setSync("save", globals.save);
                vmContext.global.setSync("random", globals.random);
                vmContext.global.setSync("game", globals.game);
                vmContext.global.setSync("actions", globals.actions, {
                    copy: true,
                });
                vmContext.global.setSync("killGame", globals.killGame);
                vmContext.global.setSync("database", globals.database);
                vmContext.global.setSync("ignore", globals.ignore);

                console.log(globals);
                // console.log(vmContext.global);
                script.runSync(vmContext, { timeout: 200 });
                // console.log(vmContext);
            }
            profiler.EndTime("Game Logic", 50);
            return true;
        } catch (e) {
            console.error("runScript Error: ", e);
            let stack = e.stack;
            stack = stack.replace(e.name + ": " + e.message + "\n", "");
            let parts = stack.split("\n");
            let body = "";
            for (var i = 0; i < parts.length; i++) {
                let part = parts[i];
                if (part.trim().length == 0) continue;
                if (part.indexOf("vm.js") == -1) continue;
                if (body.length > 0) body += "\n";
                body += part;
            }
            globalErrors = [
                {
                    type: e.name,
                    title: e.message,
                    body,
                },
            ];
            return false;
        }
    }

    onPlayerReady(action) {
        let shortid = action.user.shortid;
        let displayname = action.user.displayname;
        let ready = true;
        if (!(shortid in globalRoomState.players)) {
            globalRoomState.players[shortid] = {
                displayname,
                rank: 0,
                score: 0,
                ready,
            };
        } else {
            globalRoomState.players[shortid].ready = ready;
        }
    }

    onPlayerJoin(action) {
        let shortid = action.user.shortid;
        let displayname = action.user.displayname;
        let room_slug = action.room_slug;
        let team_slug = action.user.team_slug;

        if (!shortid) {
            console.error("Invalid player: " + shortid);
            return;
        }

        if (!(shortid in globalRoomState.players)) {
            globalRoomState.players[shortid] = {
                displayname,
                shortid,
                rank: 0,
                score: 0,
                rating: action.user.rating,
                portraitid: action.user.portraitid,
                countrycode: action.user.countrycode,
            };
        } else {
            globalRoomState.players[shortid].displayname = displayname;
            globalRoomState.players[shortid].shortid = shortid;
        }

        if (team_slug) {
            // if (!globalRoomState.teams) {
            //     globalRoomState.teams = {};
            // }
            if (!(team_slug in globalRoomState.teams)) {
                globalRoomState.teams[team_slug] = { players: [] };
            }

            globalRoomState.teams[team_slug].players.push(action.user.shortid);
            globalRoomState.players[shortid].teamid = team_slug;
        }
    }
}

module.exports = new GameRunner();

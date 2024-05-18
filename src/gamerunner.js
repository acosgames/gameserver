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
            globalResult = cloneObj(newGame);
        } catch (e) {
            console.error(e);
        }
    }),
    random: new ivm.Callback(() => {
        try {
            return DiscreteRandom.random();
        } catch (e) {
            console.error(e);
        }
    }),
    game: new ivm.Callback(() => {
        return globalRoomState;
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
            let previousRoomState = cloneObj(globalRoomState);

            //create new game
            if (!globalRoomState) {
                previousRoomState = {};
                globalRoomState = storage.makeGame(meta);
                await storage.saveRoomState("newgame", meta, globalRoomState);
            }

            if (globalRoomState.events) globalRoomState.events = {};

            for (let action of actions) {
                if (
                    action.type != "join" &&
                    action.type != "leave" &&
                    action.type != "ready" &&
                    action?.user?.shortid &&
                    globalRoomState?.timer?.sequence != action.timeseq
                ) {
                    //user must use the same sequence as the script
                    console.log(
                        "User out of sequence: ",
                        action.user,
                        globalRoomState?.timer?.sequence,
                        action.timeseq
                    );
                    return true;
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
                        },
                    };
                    rabbitmq.publish("ws", "onRoomUpdate", outMessage);
                    this.killRoom(meta.room_slug, meta);
                    return false;
                } else {
                    if (passed.type == "noshow") {
                        let outMessage = {
                            type: "noshow",
                            room_slug: action.room_slug,
                            payload: { events: { noshow: true } },
                        };
                        rabbitmq.publish("ws", "onRoomUpdate", outMessage);
                        this.killRoom(meta.room_slug, meta);
                        return false;
                    } else if (passed.isGameover || passed.type == "error") {
                        await storage.saveRoomState(
                            responseType,
                            meta,
                            globalResult
                        );
                        let deltaState = delta.delta(
                            previousRoomState,
                            globalResult,
                            {}
                        );

                        if (passed.isGameover) {
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

                    responseType = passed.type;
                    globalRoomState = cloneObj(globalResult);
                }
            }

            if (responseType == "join" && globalRoomState.players) {
                for (const shortid in globalRoomState.players) {
                    joinIds.push(shortid);
                }
                globalResult.events.join = joinIds;
            }

            await storage.saveRoomState(responseType, meta, globalResult);

            previousRoomState.events = {};

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

        if (globalRoomState?.room?.status == "gameover") {
            return false;
        }

        let prevStatus = globalRoomState?.room?.status || "pregame";

        globalRoomState.room = {
            room_slug: meta.room_slug,
            sequence: globalRoomState?.room?.sequence || 0,
            status: globalRoomState?.room?.status || "pregame",
            starttime: globalRoomState?.room?.starttime || Date.now(),
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
                case "join":
                    this.onPlayerJoin(action);
                    break;
                case "leave":
                    let players = globalRoomState.players || {};
                    let player = players[action.user.shortid];
                    if (player) {
                        player.forfeit = true;
                    }
                    room.removePlayerRoom(action.user.shortid, room_slug);
                    break;
                // case 'reset':
                //     globalRoomState = storage.makeGame(false, globalRoomState);
                //     break;
                case "skip":
                    if (!(room_slug in globalSkipCount))
                        globalSkipCount[room_slug] = 0;
                    globalSkipCount[room_slug]++;

                    if (globalSkipCount[room_slug] > 5) {
                        console.log("Too many skips: ", action);
                        return false;
                    }
                    break;
                default:
                    if (
                        action?.user?.shortid &&
                        globalRoomState?.timer?.sequence != action.timeseq
                    ) {
                        //user must use the same sequence as the script
                        console.log(
                            "User out of sequence: ",
                            action.user,
                            globalRoomState?.timer?.sequence,
                            action.timeseq
                        );
                        return false;
                    }
                    break;
            }
        } catch (e) {
            console.error(e);
            return false;
        }

        if (action.type != "skip") {
            delete globalSkipCount[room_slug];
        }

        let seedStr =
            meta.room_slug +
            globalRoomState.room.starttime +
            globalRoomState.room.sequence;
        DiscreteRandom.seed(seedStr);

        let success = await this.executeScript(gameScript, action, meta);
        if (!success) return false;

        let isGameover =
            isObject(globalResult) &&
            "events" in globalResult &&
            "gameover" in globalResult.events;
        console.log("isGameover: ", isGameover, globalResult.events);

        let responseType = "update";

        if (action.type == "join") {
            responseType = "join";
            this.onJoin(room_slug, action);
        } else if (action.type == "leave") {
            responseType = "leave";
            this.onLeave(action);
        } else if (action.type == "ready") {
            this.onReady(meta);
        } else {
            if (!isGameover) {
                // globalResult.timer.set = 100000;
                gametimer.processTimelimit(globalResult.timer);
                gametimer.addRoomDeadline(room_slug, globalResult.timer);
            } else {
                globalResult.room.status = "gameover";
            }
        }

        if (isGameover) {
            responseType = "gameover";
            if (prevStatus == "pregame" || prevStatus == "starting") {
                responseType = "noshow";
            } else await this.onGameover(meta);
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

        console.log(
            "Executed Action: ",
            action.type,
            action.room_slug,
            action.user?.shortid
        );

        if (globalResult) {
            globalResult.room = {
                room_slug: meta.room_slug,
                sequence: (globalRoomState?.room?.sequence || 0) + 1,
                status: globalRoomState?.room?.status || "pregame",
                starttime: globalRoomState?.room?.starttime || Date.now(),
                endtime: 0,
                updated: Date.now(),
            };

            if (!("timer" in globalResult)) {
                globalResult = globalRoomState.timer || {};
            }
            globalResult.timer.sequence = globalRoomState.timer.sequence;
            globalResult.timer.end = globalRoomState.timer.end;
            globalResult.timer.seconds = globalRoomState.timer.seconds;

            //globalResult.timer = globalResult.timer || {};

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
        if (!globalResult.events) globalResult.events = {};

        let events = globalResult.events;
        let event = events[type];
        if (!(type in events)) {
            event = payload;
        } else if (!Array.isArray(event)) {
            event = [event];
        } else {
            event.push(payload);
        }

        globalResult.events[type] = event;
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
        if (!roomstatus) {
            if (globalResult.state) {
                let playerList = Object.keys(players);
                if (playerList.length == 1) {
                    globalResult.room.status = "pregame";
                    globalResult.timer = { ...globalResult.timer, set: 60 };
                    gametimer.processTimelimit(globalResult.timer);
                    gametimer.addRoomDeadline(room_slug, globalResult.timer);
                }
            }
        }
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
                globalResult.room.status = "starting";

                if (meta.maxplayers == 1) {
                    events.emitGameStart({
                        type: "gamestart",
                        room_slug: meta.room_slug,
                        payload: null,
                    });
                } else {
                    let startTime = 3;
                    globalResult.timer = {
                        ...globalResult.timer,
                        set: startTime,
                    };
                    gametimer.processTimelimit(globalResult.timer);
                    gametimer.addRoomDeadline(
                        meta.room_slug,
                        globalResult.timer
                    );
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
                    await room.updateLeaderboard(
                        meta.game_slug,
                        globalResult.players
                    );
                }
            }

            if (meta.lbscore || meta.maxplayers == 1) {
                console.log("Updating high scores: ", globalResult.players);
                await rank.processPlayerHighscores(
                    meta,
                    globalResult.players,
                    storedPlayerRatings
                );
                await room.updateLeaderboardHighscore(
                    meta.game_slug,
                    globalResult.players
                );
            }
        }
    }

    runScript(script) {
        if (!script) {
            console.error("Game script is not loaded.");
            globalErrors = [
                { error: "Game script is not loaded.", payload: null },
            ];
            return false;
        }

        try {
            profiler.StartTime("Game Logic");
            {
                // vm.run(script);
                const vmContext = isolate.createContextSync();
                vmContext.global.setSync(
                    "global",
                    vmContext.global.derefInto()
                );
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

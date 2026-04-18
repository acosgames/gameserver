// const { VM, VMScript, NodeVM } = require('vm2');
import rabbitmq from "shared/services/rabbitmq.js";
import room from "shared/services/room.js";
import ratings from "shared/services/ratings.js";
import storage from "./storage.js";
import gametimer from "./gametimer.js";
import rank from "./rank.js";
import { delta } from "acos-json-encoder";
import profiler from "shared/util/profiler.js";
import events from "./events.js";
import { isObject } from "shared/util/utils.js";
import DiscreteRandom from "./DiscreteRandom.js";
// const { version } = require("os");
import ivm from "isolated-vm";
let isolateOptions = {};
let NODE_ENV = process.env.NODE_ENV;
if (NODE_ENV == "localhost" || NODE_ENV == "mobile")
    isolateOptions = { memoryLimit: 128, inspector: true };
else isolateOptions = { memoryLimit: 1024, inspector: false };
const isolate = new ivm.Isolate(isolateOptions);


function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneObj(obj) {
    try {
        return structuredClone(obj);
    } catch (e) {
        return null;
    }
}

class GameRunner {
    constructor() {
        this.roomLocks = new Map();
        this.skipCount = new Map();
        this.randomFuncs = new Map();
    }

    getIsolate() {
        return isolate;
    }

    queueRoomAction(room_slug, fn) {
        const previous = this.roomLocks.get(room_slug) || Promise.resolve();
        const next = previous.catch(() => {}).then(fn);

        this.roomLocks.set(
            room_slug,
            next.finally(() => {
                if (this.roomLocks.get(room_slug) === next) {
                    this.roomLocks.delete(room_slug);
                }
            })
        );

        return next;
    }

    createScriptGlobals(ctx, room_slug) {
        return {
            gamelog: function () {
                var args = Array.from(arguments);
                console.log.apply(console, args);
                // console.log('GAMERUNNER LOG: ', ...args)
                // return () => { }
            },
            gameerror: function () {
                var args = Array.from(arguments);
                console.error(...args);
                // return () => { }
            },
            save: new ivm.Callback((newGame) => {
                try {
                    ctx.result = structuredClone(newGame);
                } catch (e) {
                    console.error(e);
                }
            }),
            random: new ivm.Callback(() => {
                try {
                    return this.randomFuncs.get(room_slug) || DiscreteRandom.random();
                } catch (e) {
                    console.error(e);
                }
            }),
            game: new ivm.Callback(() => {
                return structuredClone(ctx.roomState);
            }),
            actions: new ivm.Callback(() => {
                return ctx.actionBatch;
            }),
            killGame: new ivm.Callback(() => {
                ctx.done = true;
            }),
            database: new ivm.Callback(() => {
                return ctx.database?.db || null;
            }),
            ignore: new ivm.Callback(() => {
                ctx.ignore = true;
            }),
        };
    }

    async killRoom(room_slug, meta, errors = []) {
        try {
            storage.removeTimer(room_slug);
            let key = meta.game_slug + "/" + room_slug;

            storage.cleanupRoom(meta); 
        
            for (var i = 0; i < errors.length; i++) {
                let error = errors[i];

                storage.addError(meta.game_slug, meta.version, error);
            }

            rabbitmq.unsubscribe("game", key, storage.getQueueKey());
            this.skipCount.delete(room_slug);
            this.randomFuncs.delete(room_slug);
        } catch (e) {}
    }

    async runAction(incomingActions, gameScript, meta) {
        return this.queueRoomAction(meta.room_slug, () => this.runActionInternal(incomingActions, gameScript, meta));
    }

    async runActionInternal(incomingActions, gameScript, meta) {
        profiler.StartTime("GameRunner.runAction");
        let passed = false;
        const ctx = {
            database: null,
            roomState: null,
            actionBatch: [],
            result: null,
            done: false,
            errors: [],
            ignore: false,
        };

        try {
            let actions = null;
            if (Array.isArray(incomingActions)) {
                actions = incomingActions;
            } else {
                actions = [incomingActions];
            }

            let responseType = "join";

            ctx.roomState = await storage.getRoomState(meta.room_slug);
            let previousRoomState = structuredClone(ctx.roomState);

            //create new game
            if (!ctx.roomState) {
                previousRoomState = {};
                ctx.roomState = storage.makeGame(meta);
                await storage.saveRoomState("newgame", meta, ctx.roomState);

                let seedStr = meta.room_slug + ctx.roomState.room.starttime;
                this.randomFuncs.set(meta.room_slug, DiscreteRandom.seed(seedStr));
            }

            if (!ctx.roomState.room?.events) ctx.roomState.room.events = {};

            let events = {};

            for (let action of actions) {
              
                //add timeleft to the action for games to use
                let timeleft = gametimer.calculateTimeleft(ctx.roomState);
                if (ctx.roomState?.room?.timeend) {
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
                    this.killRoom(meta.room_slug, meta, ctx.errors);
                    return false;
                }

                passed = await this.runActionEx(action, gameScript, meta, ctx);

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
                    this.killRoom(meta.room_slug, meta, ctx.errors);
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
                    this.killRoom(meta.room_slug, meta, ctx.errors);
                    return false;
                }

                //Gameover and errors
                if (passed.isGameover || passed.type == "error") {
                    await storage.saveRoomState(responseType, meta, ctx.result);
                    let deltaState = delta(previousRoomState, ctx.result);

                    //forward to external watchers that process ratings, stats, achievements, etc.
                    if (passed.isGameover && passed.type == "gameover") {
                        rabbitmq.publish("ws", "onRoomGameover", {
                            type: passed.type,
                            room_slug: action.room_slug,
                            meta,
                            payload: ctx.result,
                        });
                    }
                    rabbitmq.publish("ws", "onRoomUpdate", {
                        type: passed.type,
                        room_slug: action.room_slug,
                        payload: deltaState,
                    });
                    this.killRoom(meta.room_slug, meta, ctx.errors);
                    return false;
                }

                if (ctx.result?.room?.events) {
                    for (let key in ctx.result?.room?.events) {
                        if (key in events) {
                            if (!Array.isArray(events[key])) {
                                events[key] = [events[key]];
                            }
                            events[key].push(ctx.result?.room?.events[key]);
                        } else {
                            events[key] = ctx.result?.room?.events[key];
                        }
                    }
                }

                responseType = passed.type;
                ctx.roomState = cloneObj(ctx.result);
            }

            ctx.result.room.events = events;
            await storage.saveRoomState(responseType, meta, ctx.result);

            if (previousRoomState?.room) previousRoomState.room.events = {};

            // console.log("GLOBALRESULT = ", JSON.stringify(globalResult));
            let deltaState = delta(previousRoomState, ctx.result);

            // if (actions.length == 1)
            //     deltaState.action = actions[0];
            // else
            //     deltaState.action = actions;
            console.log("Game Updated: ", (new Date()).getTime());

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

    async runActionEx(action, gameScript, meta, ctx) {
        // console.log("runAction", action);
        let room_slug = meta.room_slug;

        ctx.ignore = false;

        if (!ctx.roomState) return false;

        if (
            ctx.roomState?.room?.status == "gameover" ||
            ctx.roomState?.room?.status == "gamecancelled" ||
            ctx.roomState?.room?.status == "gameerror"
        ) {
            return false;
        }

        let prevStatus = ctx.roomState?.room?.status;

        ctx.roomState.room = {
            room_slug: meta.room_slug,
            sequence: ctx.roomState?.room?.sequence || 0,
            status: ctx.roomState?.room?.status,
            starttime: ctx.roomState?.room?.starttime || Date.now(),
            next_id: ctx.roomState?.room?.next_id,
            next_action: ctx.roomState?.room?.next_action,
            timesec: ctx.roomState?.room?.timesec,
            timeend: ctx.roomState?.room?.timeend,
            events: {},
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
                    this.onPlayerReady(action, ctx);
                    break;
                case "pregame":
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    ctx.roomState.room.status = "pregame";
                    break;
                case "starting":
                    // if (globalRoomState.state)
                    ctx.roomState.room.status = "starting";
                    break;
                case "gamestart":
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    ctx.roomState.room.status = "gamestart";
                    break;
                case "gameover":
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    ctx.roomState.room.status = "gameover";
                    break;
                case "gamecancelled":
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    ctx.roomState.room.status = "gamecancelled";
                    break;
                case "gameerror":
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    ctx.roomState.room.status = "gameerror";
                    break;
                case "join":
                    this.onPlayerJoin(action, ctx);
                    break;
                case "leave":
                    let players = ctx.roomState.players || {};
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
                    if (!this.skipCount.has(room_slug)) this.skipCount.set(room_slug, 0);
                    this.skipCount.set(room_slug, this.skipCount.get(room_slug) + 1);

                    if (this.skipCount.get(room_slug) > 5) {
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
            this.skipCount.delete(room_slug);
        }

        // let seedStr = meta.room_slug + globalRoomState.room.starttime;
        // globalRandomFuncs[meta.room_slug] = DiscreteRandom.seed(seedStr);

        let success = await this.executeScript(gameScript, action, meta, ctx);
        if (!success) return false;

        if (!this.validateGlobalResult(ctx.result)) return false;

        let isGameover = false;

        if (ctx.result?.room?.events) {
            if (ctx.result.room?.events?.gameover) isGameover = "gameover";
            else if (ctx.result.room?.events?.gamecancelled) isGameover = "gamecancelled";
            else if (ctx.result.room?.events?.gameerror) isGameover = "gameerror";
        }

        // console.log("isGameover: ", isGameover, globalResult.room?.events);

        let responseType = "update";

        if (ctx.result?.room) {
            ctx.result.room.timeend = ctx.roomState.room.timeend;
            ctx.result.room.timesec = ctx.roomState.room.timesec;
        }

        if (action.type == "join") {
            responseType = "join";
            this.onJoin(room_slug, action, ctx);
        } else if (action.type == "leave") {
            responseType = "leave";
            this.onLeave(action, ctx);
        } else if (action.type == "ready") {
            this.onReady(meta, ctx);
        }

        // if (globalResult?.room?.status != "gamestart")
        if (ctx.result) {
            // globalResult.timer.set = 100000;
            let room = {
                room_slug: meta.room_slug,
                events: ctx.result?.room?.events,
                // sequence: (globalRoomState?.room?.sequence || 0) + 1,
                status: ctx.roomState?.room?.status,
                starttime: ctx.roomState?.room?.starttime || Date.now(),
                endtime: 0,
                updated: Date.now() - ctx.roomState?.room?.starttime,
                // timeend: globalResult?.room?.timeend,
                // timesec: globalResult?.room?.timesec,
                next_id: ctx.result?.room?.next_id,
                next_action: ctx.result?.room?.next_action,
            };

            if (ctx.result?.timer?.set) {
                let { timeend, timesec } = gametimer.processTimelimit(ctx.result);
                gametimer.addRoomDeadline(room_slug, timeend);

                room.timeend = timeend;
                room.timesec = timesec;
            } else {
                room.timeend = ctx.result?.room?.timeend;
                room.timesec = ctx.result?.room?.timesec;
            }

            //merge result into room state
            ctx.result = Object.assign({}, ctx.roomState, ctx.result);
            ctx.result.room = room;
        }

        if (isGameover) {
            if (isGameover) {
                ctx.result.room.status = isGameover;
                ctx.result.room.endtime = Date.now();
            }
            responseType = isGameover;
            if (prevStatus == "pregame" || prevStatus == "starting") {
                responseType = "noshow";
            } else await this.onGameover(meta, ctx);
        }

        // profiler.EndTime('WorkerManagerLoop');
        // console.timeEnd('ActionLoop');
        return { type: responseType, isGameover };
    }

    validateGlobalResult(result) {
        if (!result) return false;
        if (!result?.players) return false;
        if (!isObject(result?.players)) return false;
        for (let key in result.players) {
            if (!isObject(result.players[key])) return false;
            if (!result.players[key].displayname) return false;
        }
        if (!isObject(result?.room)) return false;

        return true;
    }

    async executeScript(gameScript, action, meta, ctx) {
        //add the game database into memory
        let key = meta.game_slug + "/server.db." + meta.version + ".json";
        let db = await storage.getGameDatabase(key);
        // console.log("database key", key, meta.game_slug);
        // console.log("database", db);

        ctx.database = db;
        ctx.actionBatch = [action];

        //run the game server script
        let succeeded = this.runScript(gameScript, meta.room_slug, ctx);
        if (!succeeded) {
            return false;
        }

        if (ctx.ignore) {
            return true;
        }

        // console.log("Executed Action: ", action.type, action.room_slug, action.user?.shortid);

        return true;
    }

    addEvent(type, payload, ctx) {
        if (!ctx.result.room?.events) ctx.result.room.events = {};

        let events = ctx.result?.room?.events;
        let event = events[type];
        if (!(type in events)) {
            event = payload;
        } else if (!Array.isArray(event)) {
            event = [event];
        } else {
            event.push(payload);
        }

        ctx.result.room.events[type] = event;
    }

    onLeave(action, ctx) {
        this.addEvent("leave", { shortid: action.user.shortid }, ctx);
        let players = ctx.result?.players;
        let player = players[action.user.shortid];
        if (player) {
            player.forfeit = true;
        }
    }
    onJoin(room_slug, action, ctx) {
        // if (!globalResult.events)
        //     globalResult.events = {}

        // globalResult.events.join = { shortid: action.user.shortid }

        //start the game if its the first player to join room
        let players = ctx.result?.players;
        let roomstatus = ctx.result?.room?.status;
        if (!roomstatus || roomstatus == "none") {
            // if (!globalResult?.room?.timeend) {
            let playerList = Object.keys(players);
            if (playerList.length == 1) {
                ctx.result.room.status = "pregame";
                ctx.result.timer = { set: 60 };
                let { timeend, timesec } = gametimer.processTimelimit(ctx.result);
                gametimer.addRoomDeadline(room_slug, timeend);

                ctx.result.room.timeend = timeend;
                ctx.result.room.timesec = timesec;
            }
            // }
        }

        if (!ctx.result.room?.events) {
            ctx.result.room.events = {};
        }
        ctx.result.room.events.join = action.user.shortid;
    }
    onReady(meta, ctx) {
        let players = ctx.result?.players;
        if (players) {
            let readyCnt = 0;
            let playerCnt = 0;
            for (var shortid in players) {
                if (players[shortid].ready) readyCnt++;
                playerCnt++;
            }

            if (playerCnt == readyCnt) {
                ctx.roomState.room.status = "starting";

                if (meta.maxplayers == 1) {
                    events.emitGameStart({
                        type: "gamestart",
                        room_slug: meta.room_slug,
                        payload: null,
                    });
                } else {
                    let startTime = 4;
                    ctx.result.timer = {
                        set: startTime,
                    };
                    let { timeend, timesec } = gametimer.processTimelimit(ctx.result);
                    gametimer.addRoomDeadline(meta.room_slug, timeend);

                    ctx.result.room.timeend = timeend;
                    ctx.result.room.timesec = timesec;
                }
            }
        }
    }

    async onGameover(meta, ctx) {
        //moving to postGameManager.js
        return;
        console.log("GAMEOVER: ", meta, ctx.result);
        if (room.getGameModeName(meta.mode) == "rank" || meta.mode == "rank") {
            let storedPlayerRatings = {};
            if (ctx.result?.timer?.sequence > 2) {
                if (meta.maxplayers > 1) {
                    await rank.processPlayerRatings(
                        meta,
                        ctx.result.players,
                        ctx.result.teams,
                        storedPlayerRatings
                    );
                    await ratings.updateLeaderboard(meta.game_slug, ctx.result.players);
                }
            }

            if (meta.lbscore || meta.maxplayers == 1) {
                console.log("Updating high scores: ", ctx.result.players);
                await rank.processPlayerHighscores(meta, ctx.result.players, storedPlayerRatings);
                await ratings.updateLeaderboardHighscore(meta.game_slug, ctx.result.players);
            }
        }
    }

    runScript(script, room_slug, ctx) {
        if (!script) {
            console.error("Game script is not loaded.");
            ctx.errors = [{ error: "Game script is not loaded.", payload: null }];
            return false;
        }

        try {
            const globals = this.createScriptGlobals(ctx, room_slug);
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

                // console.log(globals);
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
            ctx.errors = [
                {
                    type: e.name,
                    title: e.message,
                    body,
                },
            ];
            return false;
        }
    }

    onPlayerReady(action, ctx) {
        let shortid = action.user.shortid;
        let displayname = action.user.displayname;
        let ready = true;
        if (!(shortid in ctx.roomState.players)) {
            ctx.roomState.players[shortid] = {
                displayname,
                rank: 0,
                score: 0,
                ready,
            };
        } else {
            ctx.roomState.players[shortid].ready = ready;
        }
    }

    onPlayerJoin(action, ctx) {
        let shortid = action.user.shortid;
        let displayname = action.user.displayname;
        let team_slug = action.user.team_slug;

        if (!shortid) {
            console.error("Invalid player: " + shortid);
            return;
        }

        if (!(shortid in ctx.roomState.players)) {
            ctx.roomState.players[shortid] = {
                displayname,
                shortid,
                rank: 0,
                score: 0,
                rating: action.user.rating,
                portraitid: action.user.portraitid,
                countrycode: action.user.countrycode,
            };
        } else {
            ctx.roomState.players[shortid].displayname = displayname;
            ctx.roomState.players[shortid].shortid = shortid;
        }

        if (team_slug) {
            // if (!globalRoomState.teams) {
            //     globalRoomState.teams = {};
            // }
            if (!(team_slug in ctx.roomState.teams)) {
                ctx.roomState.teams[team_slug] = { players: [] };
            }

            ctx.roomState.teams[team_slug].players.push(action.user.shortid);
            ctx.roomState.players[shortid].teamid = team_slug;
        }
    }
}

export default new GameRunner();
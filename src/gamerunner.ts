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
import { GameStateReader, GameStatus, gs, PlayerReader } from "@acosgames/framework";
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
        const next = previous.catch(() => { }).then(fn);

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
            commit: new ivm.Callback((newGame) => {
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
        } catch (e) { }
    }

    async runAction(incomingActions, gameScript, meta, gameSettings) {
        return this.queueRoomAction(meta.room_slug, () => this.runActionInternal(incomingActions, gameScript, meta, gameSettings));
    }

    async runActionInternal(incomingActions, gameScript, meta, gameSettings) {
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
                ctx.roomState = storage.makeGame(meta, gameSettings);
                await storage.saveRoomState("newgame", meta, ctx.roomState);

                let seedStr = meta.room_slug + ctx.roomState.room.starttime;
                this.randomFuncs.set(meta.room_slug, DiscreteRandom.seed(seedStr));
            }

            ctx.roomState.room.events = [];

            // let events = [];

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
                        payload: { events: [{ noshow: true }] },
                    };
                    rabbitmq.publish("ws", "onRoomUpdate", outMessage);
                    this.killRoom(meta.room_slug, meta, ctx.errors);
                    return false;
                }

                passed = await this.runActionEx(action, gameScript, meta, ctx, gameSettings);

                //Error running game's server code
                if (!passed) {
                    let players;
                    if (action.type == "join") {
                        players = actions.map((a) => a.user.id);
                    }
                    let outMessage = {
                        type: "error",
                        room_slug: action.room_slug,
                        action,
                        payload: {
                            events: [{ error: "Game crashed. Please report." }],
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
                        payload: { events: [{ noshow: true }] },
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

                // if (ctx.result?.room?.events) {
                //     for (let key in ctx.result?.room?.events) {
                //         if (key in events) {
                //             if (!Array.isArray(events[key])) {
                //                 events[key] = [events[key]];
                //             }
                //             events[key].push(ctx.result?.room?.events[key]);
                //         } else {
                //             events[key] = ctx.result?.room?.events[key];
                //         }
                //     }
                // }

                responseType = passed.type;
                ctx.roomState = cloneObj(ctx.result);
                // await storage.saveRoomState(responseType, meta, ctx.result);
            }

            // ctx.result.room.events = events;
            await storage.saveRoomState(responseType, meta, ctx.result);

            if (previousRoomState?.room) 
                previousRoomState.room.events = [];

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

    async runActionEx(action, gameScript, meta, ctx, gameSettings) {
        // console.log("runAction", action);
        let room_slug = meta.room_slug;

        ctx.ignore = false;

        if (!ctx.roomState) return false;

        let game = gs(ctx.roomState);
        if (
            game.status == GameStatus.gameover ||
            game.status == GameStatus.gamecancelled ||
            game.status == GameStatus.gameerror
        ) {
            return false;
        }

        let prevStatus = game.status;
        let now = Date.now();
        let starttime = game.startTime ?? now;

        game.setSlug(room_slug);
        
        // game.setEndTime(0);

        // ctx.roomState.room = {
        //     room_slug: meta.room_slug,
        //     sequence: ctx.roomState?.room?.sequence || 0,
        //     status: ctx.roomState?.room?.status,
        //     starttime,
        //     next_player: ctx.roomState?.room?.next_player,
        //     next_team: ctx.roomState?.room?.next_team,
        //     next_action: ctx.roomState?.room?.next_action,
        //     timesec: ctx.roomState?.room?.timesec,
        //     timeend: ctx.roomState?.room?.timeend,
        //     _players: ctx.roomState?.room?._players || {},
        //     _teams: ctx.roomState?.room?._teams || {},
        //     events: ctx.roomState?.room?.events || [],
        //     endtime: 0,
        //     updated: Date.now() - starttime,
        // };

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
                    game.setStatus(GameStatus.pregame);
                    // ctx.roomState.room.status = GameStatus.pregame;
                    break;
                case "starting":
                    // if (globalRoomState.state)
                    game.setStatus(GameStatus.starting);
                    break;
                case "gamestart":
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    game.setStatus(GameStatus.gamestart);
                    break;
                case "gameover":
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    game.setStatus(GameStatus.gameover);
                    break;
                case "gamecancelled":
                    // globalRoomState = storage.makeGame(false, globalRoomState); 
                    // if (globalRoomState.state)
                    game.setStatus(GameStatus.gamecancelled);
                    break;
                case "gameerror":
                    // globalRoomState = storage.makeGame(false, globalRoomState);
                    // if (globalRoomState.state)
                    game.setStatus(GameStatus.gameerror);
                    break;
                case "join":
                    this.onPlayerJoin(action, ctx, gameSettings);
                    break;
                case "leave":
                    // let players = ctx.roomState.players || {};
                    let player = game.player(action.user.shortid); // || players[action.user.shortid];
                    if (player) {
                        player.setIngame(false);
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

        try {


            if (!this.validateGlobalResult(ctx.result)) return false;

            let isGameover = false;

            const result = gs(ctx.result);
            const eventMap = result.eventsMap();

            if (eventMap) {
                if (eventMap.gameover) isGameover = GameStatus.gameover;
                else if (eventMap.gamecancelled) isGameover = GameStatus.gamecancelled;
                else if (eventMap.gameerror) isGameover = GameStatus.gameerror;
            }

            // console.log("isGameover: ", isGameover, globalResult.room?.events);

            let responseType = "update";

            
            let now = Date.now()
            
            // result.setDeadline(ctx.roomState?.room?.timeend || 0);
            // result.setTimerSeconds(ctx.roomState?.room?.timesec || 0);

            if (action.type == "join") {
                responseType = "join";
                this.onJoin(room_slug, action, result);
            } else if (action.type == "leave") {
                responseType = "leave";
                this.onLeave(action, result);
            } else if (action.type == "ready") {
                this.onReady(meta, result);
            }

            // if (globalResult?.room?.status != "gamestart")

            // globalResult.timer.set = 100000;
            // let room = {
            //     room_slug: meta.room_slug,
            //     events: ctx.result?.room?.events,
            //     // sequence: (globalRoomState?.room?.sequence || 0) + 1,
            //     status: ctx.result?.room?.status,
            //     starttime: ctx.result?.room?.starttime || now,
            //     endtime: 0,
            //     updated: now - (ctx.roomState?.room?.starttime || 0),
            //     // timeend: globalResult?.room?.timeend,
            //     // timesec: globalResult?.room?.timesec,
            //     _players: ctx.result?.room?._players,
            //     _teams: ctx.result?.room?._teams,
            //     next_player: ctx.result?.room?.next_player,
            //     next_team: ctx.result?.room?.next_team,
            //     next_action: ctx.result?.room?.next_action,
            // };

            result.setUpdatedAt(now - result.startTime);

            if (result.timerSet) {
                let { timeend, timesec } = gametimer.processTimelimit(result);
                gametimer.addRoomDeadline(room_slug, result.startTime + timeend);

                result.setDeadline(timeend);
                result.setTimerSeconds(timesec);
            } else {
                // result.setDeadline
                // room.timeend = ctx.result?.room?.timeend;
                // room.timesec = ctx.result?.room?.timesec;
            }

            //merge result into room state
            // ctx.result = Object.assign({}, ctx.roomState, ctx.result);
            // ctx.result.room = Object.assign({}, ctx?.result?.room ?? {}, room);



            if (isGameover) {
                result.setStatus(isGameover);
                result.setEndTime(now - result.startTime);

                responseType = GameStatus[isGameover].toLowerCase();
                if (prevStatus == GameStatus.pregame || prevStatus == GameStatus.starting) {
                    responseType = "noshow";
                } 
                else {
                    await this.onGameover(meta, result);
                } 
            }
            // profiler.EndTime('WorkerManagerLoop');
            // console.timeEnd('ActionLoop');
            return { type: responseType, isGameover };
        }
        catch (e) {
            console.error(e);
            return false;
        }
    }

    validateGlobalResult(result) {
        if (!result) return false;
        if (!result?.players) return false;
        if (!Array.isArray(result?.players)) return false;
        for (let player of result.players) {
            if (!isObject(player)) return false;
            if (!player.displayname) return false;
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

    addEvent(type, payload, game) {
        game.addEvent(type, payload);
    }

    onLeave(action, game: GameStateReader) {
        game.addEvent("leave", { shortid: action.user.id });
        let player = game?.player(action.user.id);
        player?.setInGame(false);
    }

    onJoin(room_slug, action, game: GameStateReader) {

        let roomstatus = game?.status;
        if (game?.status == GameStatus.none) {
            if (game.playerCount() == 1) {
                game.setStatus(GameStatus.pregame);
                game.setTimerSet(60);
                let { timeend, timesec } = gametimer.processTimelimit(game);
                gametimer.addRoomDeadline(room_slug, game.startTime + timeend);

                game.setDeadline(timeend);
                game.setTimerSeconds(timesec);
            }
        }

        game.addEvent('join', action.user.id);
    }
    onReady(meta, game: GameStateReader) {


        let players: PlayerReader[] = game?.players();
        if (players) {
            let readyCnt = 0;
            let playerCnt = 0;
            for (var player of players) {
                if (player.isReady) readyCnt++;
                playerCnt++;
            }

            if (playerCnt == readyCnt) {
                game.setStatus(GameStatus.starting);

                if (meta.maxplayers == 1) {
                    events.emitGameStart({
                        type: "gamestart",
                        room_slug: meta.room_slug,
                        payload: null,
                    });
                } else {
                    let startTime = 4;
                    game.setTimerSet(startTime);
                    let { timeend, timesec } = gametimer.processTimelimit(game);
                    gametimer.addRoomDeadline(meta.room_slug, game.startTime + timeend);

                    game.setDeadline(timeend);
                    game.setTimerSeconds(timesec);
                }
            }
        }
    }

    async onGameover(meta, game: GameStateReader) {
        //moving to postGameManager.js
        return;
        // console.log("GAMEOVER: ", meta, ctx.result);
        // if (room.getGameModeName(meta.mode) == "rank" || meta.mode == "rank") {
        // let storedPlayerRatings = {};
        // if (ctx.result?.room?.sequence > 2) {
        //     if (meta.maxplayers > 1) {
        //         await rank.processPlayerRatings(
        //             meta,
        //             ctx.result,
        //             storedPlayerRatings
        //         );
        //         await ratings.updateLeaderboard(meta.game_slug, ctx.result.players);
        //     }
        // }

        // if (meta.lbscore || meta.maxplayers == 1) {
        //     console.log("Updating high scores: ", ctx.result.players);
        //     await rank.processPlayerHighscores(meta, ctx.result.players, storedPlayerRatings);
        //     await ratings.updateLeaderboardHighscore(meta.game_slug, ctx.result.players);
        // }
        // }
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
                vmContext.global.setSync("commit", globals.commit);
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
        let playerid = action.user.id;
        let displayname = action.user.displayname;
        if (playerid != -1) {
            ctx.roomState.players[playerid].ready = true;
        }
    }

    onPlayerJoin(action, ctx, gameSettings) {
        let playerid = action.user.id;
        let displayname = action.user.displayname;
        let teamid = action.user.teamid;

        if (typeof playerid != "number") {
            console.error("Invalid player: " + playerid);
            return;
        }

        if (playerid == -1) {
            playerid = ctx.roomState.players.length;
            let player = {
                id: playerid,
                displayname,
                shortid: action.user.shortid,
                rank: 0,
                score: 0,
                rating: action.user.rating,
                portraitid: action.user.portraitid,
                countrycode: action.user.countrycode,
            };
            ctx.roomState.players.push(player);

        } else {
            ctx.roomState.players[playerid].displayname = displayname;
            ctx.roomState.players[playerid].shortid = action.user.shortid;
            ctx.roomState.players[playerid].id = playerid;
        }

        action.user.id = playerid;
        ctx.roomState.room._players[action.user.shortid] = playerid;
        if (teamid != -1) {
            // if (!globalRoomState.teams) {
            //     globalRoomState.teams = {};
            // }
            if (!ctx.roomState.teams[teamid]) {
                ctx.roomState.teams[teamid] = { players: [] };
            }

            ctx.roomState.teams[teamid].players.push(playerid);
            ctx.roomState.players[playerid].teamid = teamid;
        }
    }
}

export default new GameRunner();
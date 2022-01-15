
const cache = require('shared/services/cache');
const room = require('shared/services/room');

var SortedSet = require('redis-sorted-set');


class Storage {

    constructor() {
        this.gameHistory = [];
        this.gameServers = {};
        this.gameDatabases = {};
        // this.roomStates = {};
        // this.roomCache = new NodeCache({ stdTTL: 300, checkperiod: 150 });

        this.loaded = {};
        this.cache = {};

        this.roomCnt = 0;
        this.rooms = {};

        this.timerSet = new SortedSet();
        this.redisTimersLoaded = false;

        this.queuekey = null;

        this.actionCountsPrev = 0;
        this.actionCounts = 0;
        this.actionCursor = 0;
        this.actionLastRunTime = 0;

    }

    clearRooms() {
        this.rooms = {};
    }
    addRoom(r) {
        this.rooms[r] = true;
    }
    getRooms() {
        return this.rooms;
    }
    setQueueKey(q) {
        this.queuekey = q;
    }
    getQueueKey() {
        return this.queuekey;
    }

    async addError(gameid, version, error) {
        return await room.addError(gameid, version, error);
    }

    getLastActionRunSeconds() {
        let now = (new Date()).getTime();
        let diff = (now - this.actionLastRunTime) / 1000;
        return diff;
    }
    //calculate the average using previous minute and current minute counts
    calculateActionRate() {
        let now = (new Date()).getTime();
        let diff = (now - this.actionLastRunTime) / 1000;
        if (diff == 0)
            diff = Number.EPSILON;
        let sum = this.actionCounts;
        let delta = ((this.actionCountsPrev) > 0 ? 1 : 0)
        let denominator = (delta + (diff / 60));
        let avg = sum / diff;
        return avg;
    }

    //count actions ran per minute
    processActionRate() {
        let now = (new Date()).getTime();
        let diff = now - this.actionLastRunTime;

        if (diff <= 60000) {
            this.actionCounts++;
            return;
        }

        this.actionCountsPrev = this.actionCounts;
        this.actionCounts = 0;
        this.actionLastRunTime = now;
    }

    incrementRoomCount() {
        this.roomCnt++;
    }
    decrementRoomCount() {
        this.roomCnt--;
    }

    getGameServers() {
        return this.gameServers;
    }
    getGameServer(id) {
        return this.gameServers[id];
    }
    setGameServer(id, game) {
        this.gameServers[id] = game;
    }

    isLoaded(game_slug) {
        return this.loaded[game_slug];
    }
    setLoaded(game_slug, isloaded) {
        this.loaded[game_slug] = isloaded;
    }

    getGameDatabases() {
        return this.gameDatabases;
    }
    getGameDatabase(id) {
        return this.gameDatabases[id];
    }
    setGameDatabase(id, db) {
        this.gameDatabases[id] = db;
    }

    async getRoomMeta(room_slug) {
        if (!room_slug)
            return null;
        let meta = await room.findRoom(room_slug);
        if (!meta) {
            return null;
        }
        return meta;
    }

    async getRoomState(room_slug) {
        let game = await cache.get(room_slug);
        // let game = this.roomStates[room_slug];
        // if (!game) {
        //     game = await redis.get(room_slug);
        // }
        if (!game) {
            game = this.makeGame(false, game);
            await cache.set(room_slug, game);
        }


        //this.roomStates[room_slug] = game;
        return game;
    }

    async saveRoomState(action, meta, roomState) {
        let room_slug = meta.room_slug;

        if (action.type == 'join' || action.type == 'leave') {
            let playerList = Object.keys(roomState.players);

            try {
                room.updateRoomPlayerCount(room_slug, playerList.length);
            }
            catch (e) {
                console.error(e);
            }
        }
        cache.set(room_slug, roomState, 6000);
    }

    async getTimerData(room_slug) {
        let timerData = await cache.get(room_slug + '/timer');
        return timerData;
    }

    async getNextTimer(gameserver_slug) {
        gameserver_slug = this.getQueueKey();
        if (!gameserver_slug)
            return false;

        //caching to avoid querying redis too much
        // let nexttimer = cache.getLocal(gameserver_slug + '/nexttimer');
        // if (nexttimer && nexttimer.length > 0) {
        //     // console.log('nexttimer', nexttimer);
        //     return nexttimer;
        // }
        let nexttimer = this.timerSet.range(0, 0, { withScores: true });
        if (nexttimer && nexttimer.length > 0)
            nexttimer = nexttimer[0];

        if (nexttimer && nexttimer.length == 2) {
            return { value: nexttimer[0], score: nexttimer[1] };
        }

        if (this.redisTimersLoaded)
            return false;

        //query redis for all timers
        let result = await cache.zrevrange(gameserver_slug + '/timer', 0, -1);
        this.redisTimersLoaded = true;
        if (!result || result.length == 0) {
            return false;
        }


        //add redis results to our local sortedset
        for (var i = 0; i < result.length; i++) {
            let timer = result[i];
            this.timerSet.add(timer.value, timer.score);
        }

        //find the next lowest
        nexttimer = this.timerSet.range(-1, undefined, { withScores: true });
        if (nexttimer && nexttimer.length > 0)
            nexttimer = nexttimer[0];

        if (nexttimer && nexttimer.length == 2) {
            return { value: nexttimer[0], score: nexttimer[1] };
        }

        return false;
    }

    async addTimer(room_slug, epoch) {
        let gameserver_slug = this.getQueueKey();
        if (!gameserver_slug)
            return;
        let roomTimer = { value: room_slug, score: epoch };
        let result = cache.zadd(gameserver_slug + '/timer', [roomTimer]);
        // console.log(result);


        this.timerSet.add(room_slug, epoch);

        // let nexttimer = cache.getLocal(gameserver_slug + '/nexttimer');
        // if (nexttimer && nexttimer.length > 0) {
        //     let found = false;
        //     for (var i = 0; i < nexttimer.length; i++) {
        //         if (nexttimer[i].value == room_slug) {
        //             nexttimer[i] = roomTimer;
        //             found = true;
        //             break;
        //         }
        //     }

        //     if (!found) {
        //         let pos = -1;
        //         for (var i = 0; i < nexttimer.length; i++) {
        //             if (nexttimer[i].score < epoch) {
        //                 pos = i;
        //                 break;
        //             }
        //         }
        //         if (pos > -1) {
        //             nexttimer.splice(pos, 0, roomTimer);
        //         }
        //     }
        // }
        // cache.delLocal(gameserver_slug + '/nexttimer');

        return result;
    }

    async removeTimer(room_slug) {
        let gameserver_slug = this.getQueueKey();
        if (!gameserver_slug)
            return;
        let result = cache.zrem(gameserver_slug + '/timer', [room_slug]);

        this.timerSet.rem(room_slug);

        // console.log(result);
        // let nexttimer = cache.getLocal(gameserver_slug + '/nexttimer');
        // if (nexttimer && nexttimer.length > 0) {
        //     let newnext = [];
        //     for (var i = 0; i < nexttimer.length; i++) {
        //         if (nexttimer[i].value != room_slug)
        //             newnext.push(nexttimer[i]);
        //         cache.setLocal(gameserver_slug + '/nexttimer', newnext);
        //     }

        // }

        return result;
    }
    async setRoomDeadline(room_slug, data) {
        cache.set(room_slug + '/timer', data);
    }

    async clearRoomDeadline(room_slug) {
        cache.del(room_slug + '/timer');
        // delete this.cache[room_slug + '/timer'];
        // await redis.del(room_slug + '/timer');
    }

    makeGame(clearPlayers, roomState) {
        if (!roomState)
            roomState = {};
        if (roomState.killGame) {
            delete roomState['killGame'];
        }
        roomState.state = {};
        roomState.rules = {};
        roomState.next = {};
        // roomState.prev = {};
        roomState.events = {};
        roomState.timer = { seq: 1 };

        if (clearPlayers) {
            roomState.players = {}
        }
        else {
            let newPlayers = {};
            for (var id in roomState.players) {
                let player = roomState.players[id];
                newPlayers[id] = {
                    name: player.name
                }
            }
            roomState.players = newPlayers;
        }
        return roomState;
    }
}

module.exports = new Storage();
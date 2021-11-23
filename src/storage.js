
const cache = require('fsg-shared/services/cache');
const room = require('fsg-shared/services/room');

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


        this.queuekey = null;

        this.actionCountsPrev = 0;
        this.actionCounts = 0;
        this.actionCursor = 0;
        this.actionLastRunTime = 0;

    }

    setQueueKey(q) {
        this.queuekey = q;
    }
    getQueueKey() {
        return this.queuekey;
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
        this.gameDatabases[id] = game;
    }

    async getRoomMeta(room_slug) {

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
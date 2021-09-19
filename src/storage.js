
const cache = require('fsg-shared/services/cache');
const room = require('fsg-shared/services/room');
const redis = require('fsg-shared/services/redis');

class Storage {

    constructor() {
        this.gameHistory = [];
        this.gameServers = {};
        this.gameDatabases = {};
        // this.roomStates = {};
        // this.roomCache = new NodeCache({ stdTTL: 300, checkperiod: 150 });

        this.loaded = {};
        this.cache = {};

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

    async addRoomDeadline(room_slug, timer) {

        if (typeof timer.seq === 'undefined')
            return;

        let curTimer = await this.getTimerData(room_slug);
        if (curTimer && curTimer.seq == timer.seq)
            return;

        let data = {
            room_slug,
            seq: timer.seq,
            end: timer.end,
        }

        cache.set(room_slug + '/timer', data);

        // this.cache[room_slug + '/timer'] = data;
        // cache.set(room_slug + '/timer', data);
        // redis.set(room_slug + '/timer', data);
        this.deadlines.enq({ end: timer.end, room_slug })
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
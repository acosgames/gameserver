
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const authentication = require('./authentication');
const helper = require('./helper');
const Holdem = require('./holdem');


const defaultOptions = {
    host: 'localhost',
    port: '8000',
    protocol: 'http:',
    prefix: '/api/v1/texasholdem',
    apikey: '',
    onLoad: null,
    onSave: null,
    games: {}
}

module.exports = class GameManager {
    constructor(options) {

        options = Object.assign(options || {}, defaultOptions);

        this.host = options.host;
        this.port = options.port;
        this.protocol = options.protocol;
        this.prefix = options.prefix;
        this.apikey = options.apikey;

        this.onLoad = options.onLoad;
        this.onSave = options.onSave;

        this.clients = {};
        this.players = {};

        this.startedGames = options.startedGames || {};
        this.games = options.games || {};
        this.cleaned = options.cleaned || {};
        this.changes = options.changes || {};

        this.holdem = new Holdem(this);
        // const holdem = new Holdem();
    }

    api(gameid) {
        let game = this.getGame(gameid);
        let type = game.type;
        return this[type];
    }

    onclientconnected(client) {
        console.log("Client connected");
        try {
            this.registerClient(client);
            this.requestAuthentication(client);
            return client;
        }
        catch (e) {
            console.error(e);
            throw e;
        }
    }

    async onclientdisconnected(client, reason) {
        if (client.user) {
            let gameid = client.user.gameid;
            await this.api(gameid).playerleave(gameid, client.user.playerid);

            this.isGameValid(gameid);
        }

        console.log("Client disconnected [reason: " + reason + "]", client.id);
        this.unregisterClient(client);
    }

    getPlayerCount(game) {
        let playerCount = 0;
        if (game.state.players) {
            playerCount = Object.keys(game.state.players).length
        }
        return playerCount;
    }

    isGameValid(gameid) {
        try {
            let game = this.getGame(gameid);
            let playerCount = this.getPlayerCount(game);
            if (playerCount > 0)
                return true;

            this.removeGame(gameid);
        }
        catch (e) {
        }
        return false;
    }

    removeGame(gameid) {
        delete this.games[gameid];
        delete this.cleaned[gameid];
        delete this.changes[gameid];
    }

    requestAuthentication(client) {
        console.log("requestAuthentication");
        try {
            client.authenticated = false;
            client.emit("connected", { connected: true, authenticated: false });
            client.on('authenticate', data => { this.onauthenticate(client, data) });
            return true;
        }
        catch (e) {
            console.error(e);
            throw { error: "E_INVALID_AUTHENTICATION" };
        }
    }

    async onauthenticate(client, data) {
        console.log("onauthentication");
        if (!await authentication.checkAPIKey(client, data)) {
            //client.emit("invalid auth", data);
            return false;
        }

        let user = client.user;
        let apikey = user.apikey;
        let playerid = user.playerid;

        this.players[playerid] = user;

        client.emit('authenticated', { playerid, apikey, connected: true, authenticated: true });

        client.on('disconnect', (data) => this.onclientdisconnected(client, data));
        client.on('action', data => { this.onaction(client, data) });
        client.on('playerjoin', data => { this.onplayerjoin(client, data) });
        client.on('ready', (data) => { this.onclientready(client, data) });
    }



    async onplayerjoin(client, data) {
        let user = client.user;
        let playerid = user.playerid;

        user.displayname = data.displayname;
        user.seatid = data.seatid;
        this.players[playerid] = user;

        console.log("Player Join:", data)
        try {
            user.gameid = data.gameid;

            let api = this.api(data.gameid);
            let game = await api.playerjoin(data.gameid, playerid, 1000, data.seatid);
            let cleaned = this.cleaned[data.gameid];
            let cleanedGame = api.cleanParamsForPlayer(cleaned, playerid);
            client.emit('onJoinGame', cleanedGame);
            // this.notifyAll('onPlayerJoin', game.id, [playerid]);
        }
        catch (e) {
            console.error(e);
            client.emit('onError', e);
        }
    }

    countready(game, skipid) {
        let isEveryoneReady = true;
        for (var playerid in game.state.players) {

            if (skipid == playerid)
                continue;

            let player = game.state.players[playerid];
            if (player.ready)
                continue;
            isEveryoneReady = false;
            break;
        }
        return isEveryoneReady;
    }

    onclientready(client, data) {
        client.user.ready = data.ready;

        let game = this.getGame(data.gameid);
        let changes = { state: { players: { [client.user.playerid]: { ready: data.ready } } } };
        let isEveryoneReady = this.countready(game, client.user.playerid);

        if (data.ready && isEveryoneReady) {
            this.api(data.gameid).newround(data.gameid);
        } else {
            this.updateGame(game.id, game, changes);
        }
    }

    getPlayer(playerid) {
        let player = this.players[playerid];
        return player;
    }

    getGame(id) {
        if (this.onLoad)
            this.onLoad(id);
        if (!this.games[id])
            throw { error: "E_INVALID_GAME" };
        return this.games[id];
    }



    listgames() {
        let gamelist = {};
        for (var id in this.games) {
            let game = this.games[id];
            let players = Object.keys(game.state.players);
            gamelist[id] = {
                id,
                players,
                rules: { ...game.rules }
            }
        }

        return gamelist;
    }


    updateGame(id, game, changes, action) {

        action = action || 'update';
        if (this.onSave)
            this.onSave(id);
        //console.log("saving:", game);

        game = helper.merge(changes, game);

        this.games[id] = game;

        let api = this.api(id);

        this.cleaned[id] = api.cleanParamsForAll(game);
        this.changes[id] = changes || {};
        this.changes[id] = api.cleanParamsForAll(changes);

        this.notifyAll(action, id);

        this.postUpdateCleanup(game);
        return game;
    }

    postUpdateCleanup(game) {

        if ('winners' in game) {
            this.nextround(game);
            delete game['winners'];
        }

        if ('_delete' in game) {
            let playerid = game._delete;
            for (var i = 0; i < game.state.seats.length; i++) {
                let seat = game.state.seats[i];
                if (seat != playerid)
                    continue;
                game.state.seats[i] = false;
            }
            // let playerid = game.state.seats[changes._delete];
            // game.state.seats[seatid] = false;
            delete game.state.players[playerid];
        }

        this.games[game.id] = game;
    }

    nextround(game) {
        setTimeout(() => {
            //game.winners = false;
            try {
                if (!this.isGameValid(game.id))
                    return;
                this.api(game.id).newround(game.id)
            }
            catch (e) {
                //game probably doesn't exist, just let it die!
                console.log(e);
            }

        }, game.rules.game.newroundDelay || 5000);
    }

    getGamePlayerIds(game) {
        if (!game || !game.state || !game.state.players)
            return [];
        return Object.keys(game.state.players);
    }

    registerClient(client) {
        this.clients[client.id] = client;

    }

    unregisterClient(client) {
        this.cleanupClient(client);
        if (client && client.id && this.clients[client.id])
            delete this.clients[client.id];
    }

    cleanupClient(client) {
        if (client.user) {
            authentication.removeUser(client.user);
        }
    }

    getClient(id) {
        if (!(this.clients[id]))
            return null;
        return this.clients[id];
    }

    notifyAll(eventName, gameid, skip) {
        skip = skip || [];
        let changes = this.changes[gameid];
        let game = this.games[gameid];
        let api = this.api(gameid);
        this.getGamePlayerIds(game).forEach(playerid => {
            if (skip.includes(playerid))
                return;

            let player = this.players[playerid];
            if (!player)
                return;
            let client = this.clients[player.clientid];
            if (!client)
                return;

            changes.id = gameid;
            let cleaned = api.cleanParamsForPlayer(changes, playerid);
            cleaned.id = gameid;
            client.emit('event', { event: eventName, game: cleaned });
        })
    }

    async onaction(client, data) {

        let user = client.user;
        let action = data.action;
        let playerid = user.playerid;

        let game = await this.api(user.gameid).onaction(user, data);
    }

    async action(id, action, game) {
        try {
            game = game || (this.getGame(id));

            // if (action == 'newround') {
            //     if (game['winners'])
            //         delete game['winners']
            //     if (game['hands'])
            //         delete game['hands']
            // }

            let changes = await this.httpPOST(action, game);
            if (!changes.error)
                await this.updateGame(id, game, changes);
        }
        catch (e) {
            console.error(e);
            throw e;
        }
        return game;
    }

    async httpPOST(action, payload) {
        var self = this;
        return new Promise((rs, rj) => {
            try {
                payload = JSON.stringify(payload);
                //payload = Buffer.from(payload, 'utf8');
                var options = {
                    host: this.host,
                    port: this.port,
                    protocol: this.protocol,
                    path: this.prefix + '/' + action,
                    method: 'POST',
                    headers: {
                        'Content-Length': Buffer.byteLength(payload),
                        'Content-Type': 'application/json'
                    }
                };

                if (this.apikey && this.apikey.length > 0)
                    options.headers['X-API-KEY'] = this.apikey;

                var req = http.request(options, response => {
                    var str = ''
                    //console.log(JSON.stringify(response.headers));
                    response.setEncoding('utf8');
                    response.on('data', chunk => { str += chunk });
                    response.on('end', () => {
                        try {
                            self.totalSize += Buffer.byteLength(str)
                            let result = JSON.parse(str);
                            rs(result);
                        }
                        catch (e) { console.error(e); rj(e); }
                    });
                    response.on('error', (e) => {
                        console.error(e);
                        rj(e);
                    });
                });

                //console.log("payload size: " + Buffer.byteLength(payload), payload)
                req.write(payload);
                req.end();
            }
            catch (e) {
                console.error(e);
                rj(e);
            }
        })
    }
}
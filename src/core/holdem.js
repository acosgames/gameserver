const http = require('http');
const { restart } = require('nodemon');
const { v4: uuidv4 } = require('uuid');

const helper = require('./helper');


module.exports = class Holdem {
    constructor(gameManager) {
        this.gm = gameManager;
    }

    async findwinner(params) {

        let id = uuidv4().replace(/\-/ig, '');
        await this.action(id, 'findwinner', params)
        return id;
    }

    async newgame(params) {

        let id = uuidv4().replace(/\-/ig, '').substr(24);

        params = params || {
            "rules": {
                "deck": {
                    "decks": 1,
                    "jokers": 2,
                    "type": "standard52"
                },
                "game": {
                    "name": "Texas Holdem",
                    "seatCount": 10
                }
            }
        };

        params.type = 'holdem';
        params.id = id;
        let game = await this.gm.action(id, 'newgame', params)
        //let game = this.getGame(id);
        return game;
    }

    async onaction(user, data) {
        let game = this.gm.getGame(user.gameid);
        if (game.winners) {
            return;
        }
        let action = data.action;
        let payload = data.payload;

        if (action == 'raise') {
            action += '/' + payload;
        }

        game = await this.gm.action(user.gameid, action, game);
    }



    async newround(id) {
        return await this.gm.action(id, 'newround')
    }

    async call(id, playerid) {

    }

    async playerjoin(id, playerid, chips, seat) {
        try {
            if (!playerid || playerid.length == 0)
                return false;

            let game = this.gm.getGame(id);
            if (playerid in game.state.players) {
                return game;
            }
            chips = chips || 0;
            seat = seat || 0;

            let action = `playerjoin/${playerid}/${chips}/${seat}`;
            return await this.gm.action(id, action);
        }
        catch (e) {
            console.error(e);
            throw e;
        }
    }

    async playerleave(id, playerid) {
        if (!playerid || playerid.length == 0)
            return false;

        let action = `playerleave/${playerid}`;
        let game = await this.gm.action(id, action);

    }



    cleanParamsForAll(game) {
        let copy = helper.clone(game);
        if (!copy.state)
            return copy;

        if (copy.state.deck)
            delete copy.state['deck'];
        if (copy.state.burned)
            delete copy.state['burned'];

        if (copy.state.players)
            for (var playerid in copy.state.players) {
                let playerState = copy.state.players[playerid];
                let player = this.gm.getPlayer(playerid);
                if (!player)
                    continue;
                playerState.displayname = player.displayname;
                playerState.ready = player.ready;

                if (playerState.cards)
                    delete playerState['cards'];
            }
        return copy;
    }

    cleanParamsForPlayer(game, targetid) {
        let copy = helper.clone(game);
        let original = this.gm.getGame(game.id);

        //show cards for this player only
        if (copy.state && copy.state.players && copy.state.players[targetid]) {
            let player = copy.state.players[targetid];
            let origPlayer = original.state.players[targetid];
            if (!origPlayer)
                return copy;

            if ('cards' in player)
                player.cards = origPlayer.cards;
        }

        return copy;
    }
};

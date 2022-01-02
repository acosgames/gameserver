var { rating, rate, ordinal } = require('openskill');
const room = require('shared/services/room');
const GameService = require('shared/services/game');
const game = new GameService();

const { setPlayerRating } = require('shared/services/room');

class Rank {
    constructor() { }

    async processPlayerRatings(meta, players, storedPlayerRatings) {

        //add saved ratings to players in openskill format
        storedPlayerRatings = storedPlayerRatings || {};
        let playerRatings = {};
        let rankOne = [];
        let rankOther = [];
        let playerList = [];


        let roomRatings = await room.findPlayerRatings(meta.room_slug, meta.game_slug);
        if (roomRatings && roomRatings.length > 0) {
            for (var i = 0; i < roomRatings.length; i++) {
                let roomRating = roomRatings[i]
                storedPlayerRatings[roomRating.shortid] = roomRating;
            }
        }

        for (var id in players) {
            let player = players[id];

            if (!(id in storedPlayerRatings)) {
                storedPlayerRatings[id] = await room.findPlayerRating(id, meta.game_slug);
            }
            if ((typeof player.rank === 'undefined')) {
                console.error("Player [" + id + "] (" + player.name + ") is missing rank")
                return;
            }

            let playerRating = storedPlayerRatings[id];

            playerRating.rank = player.rank;
            if ((typeof player.score !== 'undefined')) {
                playerRating.score = player.score;
            }
            playerRatings[id] = playerRating;

        }

        let lowestRank = 99999;
        for (var id in players) {
            let player = players[id];
            if (player.rank < lowestRank)
                lowestRank = player.rank;
        }
        for (var id in players) {
            let player = players[id];
            if ((typeof player.rank === 'undefined')) {
                console.error("Player [" + id + "] (" + player.name + ") is missing rank")
                return;
            }

            if (player.rank == lowestRank) {
                rankOne.push(storedPlayerRatings[id]);
            }
            else {
                rankOther.push(storedPlayerRatings[id]);
            }
        }

        let isTied = false;
        if (rankOther.length == 0) {
            isTied = true;
            for (var playerRating of rankOne) {
                playerRating.tie++;
            }
        }
        else {
            for (var playerRating of rankOne) {
                playerRating.win++;
            }
            for (var playerRating of rankOther) {
                playerRating.loss++;
            }
        }




        // console.log("Before Rating: ", playerRatings);
        //run OpenSkill rating system
        this.calculateRanks(playerRatings);

        //update player ratings from openskill mutation of playerRatings
        let ratingsList = [];


        for (var id in players) {
            let player = players[id];

            if (!(id in playerRatings)) {
                continue;
            }
            let rating = playerRatings[id];

            rating.played = Number(rating.played) + 1;

            //UPDATE PLAYER data sent back, using private fields to hide the win/loss/tie/played counts from others
            player.rating = rating.rating;
            player.ratingTxt = game.ratingToRank(rating.rating);
            player._win = rating.win;
            player._loss = rating.loss;
            player._tie = rating.tie;
            player._played = rating.played;

            ratingsList.push({
                shortid: id,
                game_slug: meta.game_slug,
                rating: rating.rating,
                mu: rating.mu,
                sigma: rating.sigma,
                win: rating.win,
                tie: rating.tie,
                loss: rating.loss
            });

            delete rating['rank'];
            delete rating['score'];

            setPlayerRating(id, meta.game_slug, rating);
        }

        room.updateAllPlayerRatings(ratingsList);

        // console.log("After Rating: ", storedPlayerRatings);
        return ratingsList;
    }




    calculateRanks(players, teams) {

        if (teams) {
            return this.calculateTeams(players, teams);
        }

        return this.calculateFFA(players);
    }

    calculateTeams(players, teams) {
        return true;
    }

    calculateFFA(players) {
        let rank = [];
        let score = [];
        let ratings = [];
        let teams = [];

        if (!players)
            return false;

        try {
            //create the arrays required by openskill library
            //sync teams and players list to match with the ratings list
            for (var id in players) {
                let player = players[id];
                let playerRating = rating({ mu: player.mu, sigma: player.sigma });
                ratings.push([playerRating]);
                teams.push([id]);
                rank.push(player.rank);
                if (player.score)
                    score.push(player.score);
            }

            //calculate the results 
            let results = null;
            if (score.length != rank.length) {
                results = rate(ratings, { rank });
            } else {
                results = rate(ratings, { rank, score });
            }

            //update player ratings for saving to storage
            for (var i = 0; i < teams.length; i++) {
                let team = teams[i];
                for (var j = 0; j < team.length; j++) {
                    let id = team[j];
                    let player = players[id];
                    let playerRating = results[i][j];
                    player.mu = playerRating.mu;
                    player.sigma = playerRating.sigma;
                    player.rating = Math.round(playerRating.mu * 100.0);
                }
            }

            return true;
        }
        catch (e) {
            console.error(e);
            return false;
        }
    }
}


function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min) + min); //The maximum is exclusive and the minimum is inclusive
}

function test() {

    let r = new Rank();

    let playerList = [];

    //create players
    for (var i = 0; i < 4; i++) {
        let id = i;
        let mu = 25;
        let sigma = 5;
        let player = {
            id, mu, sigma
        }
        playerList.push(player);
    }

    //fight players

    for (var i = 0; i < 10; i++) {
        let player1id = 1;//getRandomInt(0, 2);
        let player2id = 2;//getRandomInt(2, 4);
        if (player1id == player2id) {
            i--;
            continue;
        }

        let player1 = playerList[player1id];
        let player2 = playerList[player2id];

        let players = {};
        players[player1id] = player1;
        players[player2id] = player2;


        if (i < 980) {
            player1.rank = 1;
            player2.rank = 2;
            player1.score = 10;
            player2.score = 50;
        }
        else {
            player2.rank = 1;
            player1.rank = 2;
            player2.score = 10;
            player1.score = 50;
        }



        r.calculateFFA(players);
    }

    for (var i = 0; i < playerList.length; i++) {
        console.log("Player [" + i + "] - mu:" + playerList[i].mu + ', sigma:' + playerList[i].sigma);
    }






}

// test();

module.exports = new Rank();
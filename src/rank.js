var { rating, rate, ordinal } = require('openskill');
const room = require('fsg-shared/services/room');
const { setPlayerRating } = require('fsg-shared/services/room');

class Rank {
    constructor() { }

    async processPlayerRatings(meta, players, storedPlayerRatings) {

        //add saved ratings to players in openskill format
        storedPlayerRatings = storedPlayerRatings || {};
        let playerRatings = {};
        let rankOne = [];
        let rankOther = [];
        let playerList = [];




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

        for (var id in players) {
            let player = players[id];
            if ((typeof player.rank === 'undefined')) {
                console.error("Player [" + id + "] (" + player.name + ") is missing rank")
                return;
            }

            if (player.rank == 1) {
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
            player.rating = rating.rating;

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

module.exports = new Rank();
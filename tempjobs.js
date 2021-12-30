
const room = require('shared/services/room');
const { genShortId } = require('shared/util/idgen');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {


    let ratings = [];

    for (var i = 0; i < 1000000; i++) {

        let rating = Math.random() * (3000 - 200) + 200;
        let mu = Math.random() * (30 - 2) + 2;
        let sigma = Math.random() * (12 - 0.1) + 0.1;
        ratings.push({
            shortid: genShortId(10),
            game_slug: 'test',
            rating,
            mu,
            sigma
        })

    }

    await room.updateAllPlayerRatings(ratings);
    console.log("Done adding " + ratings.length + " users");
}


run();


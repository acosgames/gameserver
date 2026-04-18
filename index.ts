// const WorkerManager = require('./src/workermanager');
// const wm = new WorkerManager();

import axios from "axios";
import credutil from "shared/util/credentials.js";
import gamequeue from "./src/gamequeue.js";
import gamereceiver from './src/gamereceiver.js';
axios.interceptors.response.use(
    response => {
        return response
    },
    error => {
        if (!error.response) {
            console.log("Waiting on api to be online...");
        }

        return Promise.reject(error)
    }
)

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function start() {

    let credentials = credutil();
    let url = credentials.platform.api.url;
    while (true) {

        try {
            let response = await axios.get(url)
            if (response)
                break;
        }
        catch (e) { }

        await sleep(2000);
    }

    await gamereceiver.start()

    gamequeue.start();
    console.log("[GameServer] STARTED @ " + (new Date()).toString());
    // wm.connect();
}

start();


process.on('SIGINT', function () {
    console.log('SIGINT');
    process.exit();
});




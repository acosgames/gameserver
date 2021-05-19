const { workerData, parentPort } = require("worker_threads")

const fs = require('fs');
const { VM, VMScript, NodeVM } = require('vm2');
const profiler = require('fsg-shared/util/profiler')

var Queue = require('queue-fifo');

var globalState = { test: '123' };
var globalAction = {};
var globalResult = null;

var globals = {
    log: (msg) => { console.log(msg) },
    error: (msg) => { console.error(msg) },
    finish: (newState) => {
        globalResult = cleanupState(newState);
        parentPort.postMessage(globalResult);
    },
    state: () => globalState,
    action: () => globalAction
};

const vm = new VM({
    console: false,
    wasm: false,
    eval: false,
    fixAsync: true,
    timeout: 500,
    sandbox: { globals },
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanupState(state) {

    return Object.assign({}, state);
}

async function downloadGame(game_slug) {
    let filepath = './src/core/example.js';
    var data = fs.readFileSync(filepath, 'utf8');
    var scriptVM = new VMScript(data);
    return scriptVM;
}

var index = workerData.index;

async function sandbox() {
    try {

        var actions = new Queue();
        var games = {};
        var states = {};

        parentPort.on('message', async (msg) => {
            let game_slug = msg.game_slug;
            let room_slug = msg.room_slug;

            console.log("Sandbox [" + index + "] received: ", msg);

            if (!(game_slug in games)) {
                try {
                    let script = await downloadGame(game_slug);
                    games[game_slug] = { script }
                } catch (e) {
                    console.log('Error:', e);
                }
            }

            if (!game_slug || !room_slug)
                return;

            actions.enqueue(msg);
        });

        parentPort.on('close', () => {

        });

        parentPort.postMessage({ status: "READY" });

        process.on('uncaughtException', (err) => {
            console.error('Asynchronous error caught.', err);
        })

        while (true) {

            if (actions.size() == 0) {
                await sleep(20);
                continue;
            }

            let peeked = actions.peek();
            let game = games[peeked.game_slug];
            if (!game)
                continue;

            globalState = states[peeked.room_slug];
            if (!globalState) {

            }

            globalAction = actions.dequeue();
            if (!globalAction.game_slug) {
                continue;
            }

            try {
                profiler.Start('Run Bundle for: ' + globalAction.game_slug);
                {
                    vm.run(game.script);
                }
                profiler.End('Run Bundle for: ' + globalAction.game_slug);
            }
            catch (e) {
                console.error(e);
            }
        }
    }
    catch (e) {
        console.error(e);
    }
}


sandbox();
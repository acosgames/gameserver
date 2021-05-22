const { workerData, parentPort } = require("worker_threads")
const fs = require('fs');
const { VM, VMScript, NodeVM } = require('vm2');

const profiler = require('fsg-shared/util/profiler')
const redis = require('fsg-shared/services/redis');
const NodeCache = require("node-cache");
var states = new NodeCache({ stdTTL: 60, checkperiod: 120 });
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
    eval: true,
    fixAsync: true,
    timeout: 500,
    sandbox: { globals },
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


const index = workerData.index;
const redisCred = workerData.redisCred;


class FSGWorker {
    constructor() {
        this.actions = new Queue();
        this.games = {};
        this.states = {};
    }

    async start() {
        try {

            await redis.connect(redisCred);

            parentPort.on('message', onMessage);
            parentPort.on('close', onClose);
            parentPort.postMessage({ status: "READY" });
            process.on('uncaughtException', onException)

            while (true) {

                if (this.actions.size() == 0) {
                    await sleep(20);
                    continue;
                }

                mainLoop();
            }
        }
        catch (e) {
            console.error(e);
        }
    }

    mainLoop() {
        let peeked = this.actions.peek();
        let game = this.games[peeked.game_slug];
        if (!game)
            return;

        globalState = this.states[peeked.room_slug];
        if (!globalState) {
        }

        globalAction = this.actions.dequeue();
        if (!globalAction.game_slug) {
            return;
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


    cleanupState(state) {

        return Object.assign({}, state);
    }

    async downloadGame(game_slug) {
        let filepath = './src/core/example.js';
        var data = fs.readFileSync(filepath, 'utf8');
        var scriptVM = new VMScript(data);
        return scriptVM;
    }

    async downloadState(room_slug) {
        var state = await redis.get(room_slug);
        return state;
    }


    async onMessage(msg) {
        let game_slug = msg.game_slug;
        let room_slug = msg.room_slug;

        console.log("Sandbox [" + index + "] received: ", msg);

        if (!(game_slug in this.games)) {
            try {
                let script = await downloadGame(game_slug);
                this.games[game_slug] = { script }
            } catch (e) {
                console.log('Error:', e);
            }
        }

        if (!game_slug || !room_slug)
            return;

        this.actions.enqueue(msg);
    }

    async onClose() {

    }

    onException(err) {
        console.error('Asynchronous error caught.', err);
    }

}


sandbox();
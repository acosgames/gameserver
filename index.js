// import express from "express.js"
// const app = express();
// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));


// import TexasHoldemAPI from './src/Games/TexasHoldEm/api.js'
// TexasHoldemAPI.routing(app);
// app.listen(8000)
// console.log("Listening on port 8000");

const profiler = require('./forkoff-shared/util/Profiler.js')
const { Worker } = require("worker_threads")
// const workerpool = require('workerpool');
// const pool = workerpool.pool();

// var nodejsApp = require('./child.js');

function runWorker(filename) {
    return new Promise((resolve, reject) => {
        //first argument is filename of the worker
        const worker = new Worker(filename, {});
        worker.on("message", resolve) //This promise is gonna resolve when messages comes back from the worker thread
        worker.on("error", reject)
        worker.on("exit", code => {
            if (code !== 0) {
                reject(new Error(`Worker stopped with exit code ${code}`))
            }
            profiler.End('workerTest');
        })
        //worker.
    })
}

async function run() {
    profiler.Start('workerTest');
    let state = await runWorker('./child.js');

}

run();

// const workerFarm = require('worker-farm')
//     , workers = workerFarm({
//         workerOptions: {}
//         , maxCallsPerWorker: 1
//         , maxConcurrentWorkers: require('os').cpus().length
//         , maxConcurrentCallsPerWorker: 1
//         , maxConcurrentCalls: 1
//         , maxCallTime: Infinity
//         , maxRetries: 5
//         , autoStart: false
//         , onChild: function () { }
//     }, nodejsApp)

// const profiler = require('./Profiler.js')
// profiler.Start('workerTest');
// workers((output) => {
//     console.log(output);
//     profiler.End('workerTest');
// })

// workerFarm.end(workers);
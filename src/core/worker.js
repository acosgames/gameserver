const { workerData, parentPort } = require("worker_threads")

const fs = require('fs');
const { VM, VMScript } = require('vm2');
const profiler = require('fsg-shared/util/profiler')

var bundle = {
    log: (msg) => { console.log(msg) },
    error: (msg) => { console.error(msg) },
};

const vm = new VM({
    console: false,
    sandbox: { bundle },
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

var index = workerData.index;

async function sandbox() {
    try {

        parentPort.on('message', (msg) => {
            console.log("Sandbox [" + index + "] received: ", msg);
        });

        parentPort.on('close', () => {

        });

        parentPort.postMessage({ status: "created" });

        while (true) {

            await sleep(20);
        }
        // console.log("Starting Sandbox...");
        // let filepath = './dist/bundle.js';
        // var scriptVM = new VMScript(fs.readFileSync(filepath, 'utf-8'), filepath);
        // profiler.Start('Run Bundle');
        // vm.run(scriptVM);
        // console.log(bundle.result);
        // profiler.End('Run Bundle');
        // return bundle.result;

        return "";
        //console.log('(' + process.pid + ') = ' + result);
        //callback(bundle.result);
        // return bundle.result;
    }
    catch (e) {
        console.error(e);
    }
}


sandbox();
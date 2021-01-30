const { workerData, parentPort } = require("worker_threads")

const fs = require('fs');
const { VM, VMScript } = require('vm2');
const profiler = require('./Profiler.js')

var bundle = {
    log: (msg) => { console.log(msg) },
    error: (msg) => { console.error(msg) },
};

const vm = new VM({
    console: false,
    sandbox: { bundle },
});


function runGameSandbox() {
    try {
        console.log("Starting Sandbox...");
        let filepath = './dist/bundle.js';
        var scriptVM = new VMScript(fs.readFileSync(filepath, 'utf-8'), filepath);

        profiler.Start('Run Bundle');
        vm.run(scriptVM);
        console.log(bundle.result);
        profiler.End('Run Bundle');
        //console.log('(' + process.pid + ') = ' + result);

        //callback(bundle.result);
        return bundle.result;
    }
    catch (e) {
        console.error(e);
    }
    // callback(null, inp + ' BAR (' + process.pid + ')')
}


parentPort.postMessage(runGameSandbox())


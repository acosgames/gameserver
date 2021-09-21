
const events = require('events');
const emitter = new events.EventEmitter();

class Events {

    constructor() { }

    addNextActionListener(func) {
        emitter.on('onNextAction', func);
    }
    emitNextAction(payload) {
        emitter.emit('onNextAction', payload);
    }

    addLoadGameListener(func) {
        emitter.on('onLoadGame', func);
    }
    emitLoadGame(payload) {
        emitter.emit('onLoadGame', payload);
    }

    addSkipListener(func) {
        emitter.on('onSkip', func);
    }
    emitSkip(payload) {
        emitter.emit('onSkip', payload);
    }
}

module.exports = new Events();
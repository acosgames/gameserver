
const events = require('./events');
const storage = require('./storage');
class GameTimer {

    constructor() {

        this.setup();
    }

    setup() {
        setInterval(() => {

            this.processDeadlines();

        }, 50)
    }

    calculateTimeleft(roomState) {
        if (!roomState || !roomState.timer || !roomState.timer.end)
            return 0;

        let deadline = roomState.timer.end;
        let now = (new Date()).getTime();
        let timeleft = deadline - now;

        return timeleft;
    }

    processTimelimit(timer) {

        if (!timer) {
            timer = { seq: 1 }
        }
        if (!timer || !timer.set)
            return;

        if (typeof timer.set === 'undefined')
            return;

        let seconds = Math.min(3000000, Math.max(1, timer.set));
        let sequence = timer.seq || 0;
        let now = (new Date()).getTime();
        let deadline = now + (seconds * 1000);
        // let timeleft = deadline - now;

        timer.end = deadline;
        timer.seconds = seconds;
        // timer.data = [deadline, seconds];
        timer.seq = sequence + 1;
        delete timer.set;
    }

    async processDeadlines() {
        let next = await storage.getNextTimer();
        if (!next || !next.value)
            return;

        let action = await this.processDeadlinesEX(next);
        if (!action)
            return;


        if (typeof action === 'object') {
            events.emitSkip(action);
            await storage.removeTimer(action.room_slug);
        }

        this.processDeadlines();
    }
    async processDeadlinesEX(next) {
        try {
            let room_slug = next.value;
            let roomState = await storage.getRoomState(room_slug);
            if (!roomState) {
                await storage.removeTimer(room_slug);
                return true;
            }

            let now = (new Date()).getTime();
            if (now < next.score)
                return false;

            let action = {};
            if (!(roomState.state?.gamestatus)) {
                console.log("timer ended: unkonwn");
                action = {
                    type: 'noshow',
                    room_slug
                }
            }
            else {
                switch (roomState.state?.gamestatus) {
                    case 'pregame':
                        console.log("timer ended: pregame");
                        action = {
                            type: 'noshow',
                            room_slug
                        }
                        break;
                    case 'starting':
                        console.log("timer ended: starting");
                        action = {
                            type: 'gamestart',
                            room_slug,
                        }
                        break;
                    case 'gamestart':
                        console.log("timer ended: gamestart");
                        action = {
                            type: 'skip',
                            room_slug,
                        }
                        break;
                    case 'gameover':
                        return;
                }
            }

            return action;
        }
        catch (e) {
            console.error(e);
        }
    }


    async removeRoomDeadline(room_slug) {
        storage.removeTimer(room_slug);
    }


    async addRoomDeadline(room_slug, timer) {
        if (!timer || !timer.end) {
            return;
        }

        console.log("Adding timer: ", room_slug, timer);
        storage.addTimer(room_slug, timer.end);
    }

}

module.exports = new GameTimer();
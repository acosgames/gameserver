var PriorityQueue = require('priorityqueuejs');
const events = require('./events');
const storage = require('./storage');
class GameTimer {

    constructor() {

        this.deadlines = new PriorityQueue(function (a, b) {
            return b.end - a.end;
        });


        this.setup();
    }

    setup() {
        setInterval(() => {

            this.processDeadlines();

        }, 500)
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

        if (!timer || !timer.set)
            return;

        if (typeof timer.set === 'undefined')
            return;

        let seconds = Math.min(60, Math.max(10, timer.set));
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
        try {
            if (this.deadlines.size() == 0)
                return;
            let next = this.deadlines.peek();

            let room_slug = next.room_slug;
            let roomTimer = await storage.getTimerData(room_slug);
            let now = (new Date()).getTime();

            if (!roomTimer || typeof roomTimer.end == 'undefined' || roomTimer.end != next.end) {
                this.deadlines.deq();
                return;
            }

            if (now < roomTimer.end)
                return;


            let action = {
                type: 'skip',
                room_slug,
            }

            events.emitSkip(action);
            // this.onNextAction(action);


            this.deadlines.deq();
            storage.clearRoomDeadline(room_slug);
            this.processDeadlines();
        }
        catch (e) {
            console.error("ProcessTime Error: ", e)
        }

    }





}

module.exports = new GameTimer();
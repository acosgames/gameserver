const events = require("./events");
const storage = require("./storage");
class GameTimer {
    constructor() {
        this.setup();
    }

    setup() {
        setInterval(() => {
            this.processDeadlines();
        }, 50);
    }

    calculateTimeleft(roomState) {
        if (!roomState || !roomState.room || !roomState.room.timeend) return 0;

        let deadline = roomState.room.timeend;
        let now = new Date().getTime();
        let timeleft = deadline - now;

        return timeleft;
    }

    processTimelimit(gamestate) {
        // if (!room) {
        //     timer = { sequence: 0 };
        // }
        let timer = gamestate?.timer;
        if (!timer || !timer.set) return;
        if (typeof timer.set === "undefined") return;

        let timesec = Math.min(3000000, Math.max(1, timer.set));
        // let sequence = timer.sequence || 0;
        let now = new Date().getTime();
        let timeend = now + timesec * 1000;
        // let timeleft = deadline - now;

        // let room = gamestate?.room;
        // room.timeend = timeend;
        // room.timesec = timesec;
        // timer.data = [deadline, seconds];
        // timer.sequence = sequence + 1;
        delete gamestate.timer;
        return { timeend, timesec };
    }

    async processDeadlines() {
        let next = await storage.getNextTimer();
        if (!next || !next.value) return;

        let action = await this.processDeadlinesEX(next);
        if (!action) return;

        if (typeof action === "object") {
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

            let now = new Date().getTime();
            if (now < next.score) return false;

            let action = {};
            if (!roomState.room?.status || roomState?.room?.status == "none") {
                console.log("timer ended: unkonwn");
                action = {
                    type: "noshow",
                    room_slug,
                };
            } else {
                switch (roomState.room?.status) {
                    case "pregame":
                        console.log("timer ended: pregame");
                        action = {
                            type: "noshow",
                            room_slug,
                        };
                        break;
                    case "starting":
                        console.log("timer ended: starting");
                        action = {
                            type: "gamestart",
                            room_slug,
                        };
                        break;
                    case "gamestart":
                        console.log("timer ended: gamestart");
                        action = {
                            type: "skip",
                            room_slug,
                        };
                        break;
                    case "gameover":
                    case "gamecancelled":
                    case "gameerror":
                        return;
                }
            }

            return action;
        } catch (e) {
            console.error(e);
        }
    }

    async removeRoomDeadline(room_slug) {
        storage.removeTimer(room_slug);
    }

    async addRoomDeadline(room_slug, timeend) {
        if (typeof timeend === "undefined") {
            return;
        }

        console.log("Adding timer: ", room_slug, timeend);
        storage.addTimer(room_slug, timeend);
    }
}

module.exports = new GameTimer();

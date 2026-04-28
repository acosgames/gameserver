import { GameStatus } from "@acosgames/framework";
import events from "./events.js";
import storage from "./storage.js";
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
        if (!roomState || !roomState.room || !roomState.room.timeend)
            return 0;
        let deadline = roomState.room.starttime + roomState.room.timeend;
        let now = new Date().getTime();
        let timeleft = deadline - now;
        return timeleft;
    }
    processTimelimit(game) {
        const timer = game.timerSet;
        const timesec = Math.min(3000000, Math.max(1, timer));
        const now = Date.now();
        const timeend = (now + timesec * 1000) - game.startTime;
        if (game.timeset) {
            let room = game.raw().room;
            delete room.timeset;
        }
        return { timeend, timesec };
    }
    async processDeadlines() {
        let next = await storage.getNextTimer();
        if (!next || !next.value)
            return;
        let action = await this.processDeadlinesEX(next);
        if (!action)
            return;
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
            if (now < next.score)
                return false;
            let action = null;
            if (!roomState.room?.status || roomState?.room?.status == GameStatus.none) {
                console.log("timer ended: unkonwn");
                action = {
                    type: "noshow",
                    room_slug,
                };
            }
            else {
                switch (roomState.room?.status) {
                    case GameStatus.waiting:
                        console.log("timer ended: waiting");
                        action = {
                            type: "noshow",
                            room_slug,
                        };
                        break;
                    case GameStatus.pregame:
                        console.log("timer ended: pregame");
                        action = {
                            type: "noshow",
                            room_slug,
                        };
                        break;
                    case GameStatus.starting:
                        console.log("timer ended: starting");
                        action = {
                            type: "gamestart",
                            room_slug,
                        };
                        break;
                    case GameStatus.gamestart:
                        console.log("timer ended: gamestart");
                        action = {
                            type: "skip",
                            room_slug,
                        };
                        break;
                    case GameStatus.gameover:
                    case GameStatus.gamecancelled:
                    case GameStatus.gameerror:
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
    async addRoomDeadline(room_slug, timeend) {
        if (typeof timeend === "undefined") {
            return;
        }
        console.log("Adding timer: ", room_slug, timeend);
        storage.addTimer(room_slug, timeend);
    }
}
export default new GameTimer();
//# sourceMappingURL=gametimer.js.map
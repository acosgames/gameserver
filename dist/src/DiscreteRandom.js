import seedrandom from 'seedrandom';
class DiscreteRandom {
    constructor() {
        this.sequence = 0;
        this.randomFunc = null;
    }
    seed(seedString) {
        // this.sequence = sequence;
        //if (!this.randomFunc) {
        // let seedStr = this.nextGame.room.room_slug + this.nextGame.room.starttime + this.sequence;
        // let seed = this.generateRandomSeed(seedString);
        // this.log("seedStr:", seedStr, ", seed", seed);
        this.randomFunc = seedrandom(seedString);
        // this.randomFunc = this.mulberry32(seed[0]);
        //}
    }
    random() {
        if (!this.randomFunc) {
            return Math.random();
        }
        let num = this.randomFunc();
        // console.log("Random number:", num);
        return num;
    }
}
export default new DiscreteRandom();
//# sourceMappingURL=DiscreteRandom.js.map
declare class Rank {
    constructor();
    processPlayerHighscores(meta: any, players: any, storedPlayerRatings: any): Promise<void>;
    processPlayerRatings(meta: any, players: any, teams: any, storedPlayerRatings: any): Promise<any[]>;
    calculateRanks(players: any, teams: any): boolean;
    calculateTeams(players: any, gameteams: any): boolean;
    calculateFFA(players: any): boolean;
}
declare const _default: Rank;
export default _default;
//# sourceMappingURL=rank.d.ts.map

const credutil = require('fsg-shared/util/credentials');
const InstanceLocalService = require('fsg-shared/services/instancelocal');
const local = new InstanceLocalService();
const WSClient = require('./WSClient');
const { getLocalAddr } = require('fsg-shared/util/address');

class Cluster {
    constructor(credentials) {
        this.credentials = credentials || credutil();

        this.port = process.env.PORT || this.credentials.platform.gameserver.port;
    }

    async register() {

        let params = {
            public_addr: this.port,
            private_addr: getLocalAddr() + ':' + this.port,
            hostname: "gameserver",
            zone: 0,
            instance_type: 3
        }
        this.server = await local.register(params);
        console.log("GameServer registered: ", this.server);
        return this.server;
    }

    async connectToCluster() {
        let clusters = this.server.clusters;
        this.cluster = clusters[0];

        let addr = this.cluster.private_addr;

        await WSClient.connect(
            addr,
            this.onClusterOpen.bind(this),
            this.onClusterError.bind(this),
            this.onClusterMessage.bind(this)
        )
    }

    async onClusterOpen(client, event) {

    }

    async onClusterError(client, error) {

    }

    async onClusterMessage(client, error) {

    }
}

module.exports = new Cluster();
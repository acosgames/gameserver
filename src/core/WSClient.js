const { w3cwebsocket } = require("websocket");
const credutil = require('fsg-shared/util/credentials');

class WSClient {
    constructor(credentials) {
        this.credentials = credentials || credutil();
    }

    async connect(addr, cbOpen, cbError, cbMessage) {

        this.client = new w3cwebsocket(`ws://${addr}/`, this.credentials.platform.gameserver.gamekey, '*', {});

        this.cbOpen = cbOpen || null;
        this.cbError = cbError || null;
        this.cbMessage = cbMessage || null;

        this.client.onopen = this.onOpen.bind(this);
        this.client.onerror = this.onError.bind(this);
        this.client.onmessage = this.onMessage.bind(this);
    }

    async onOpen(event) {

        if (this.cbOpen) {
            this.cbOpen(this.client, event);
        }
        //console.log(event);
        console.log('WSClient Connected to Cluster');

        if (this.client.readyState == this.client.OPEN) {

        }
    }

    async onError(error) {
        if (this.cbError) {
            this.cbError(this.client, error);
        }
        console.error(error);
    }

    async onMessage(message) {
        if (this.cbMessage) {
            this.cbMessage(this.client, message);
        }

        // let buffer = await message.data.arrayBuffer();
        // let msg = decode(buffer);
        // console.log(msg);
    }
}

module.exports = new WSClient();
const { v4: uuidv4 } = require('uuid');


//use this class to implement a fancy authentication
class Authentication {
    constructor() {
        this.users = {};
    }

    generateAPIKey() {
        return uuidv4().replace(/\-/ig, '');
    }

    checkLogin(request, response, next) {

        if (!request.session.user) {
            //do login flow
            let passed = this.loginUser(request, response);
            if (!passed) {
                console.log("User is not authenticated");
                response.json({ error: "E_INVALID_AUTH" });
                return;
            }
        }
        else {
            let user = request.session.user;
            this.users[user.apikey] = user;
        }


        next();
    }

    //TODO: redirect user to login, must implement OIDC/Social login flow
    loginUser(request, response) {
        let session = request.session;
        let apikey = this.generateAPIKey();

        let sessionid = request.sessionID;
        let playerid = this.generateAPIKey().substr(24);

        let user = this.users[apikey] || {};
        user.apikey = apikey;
        user.playerid = playerid;
        user.sessionid = sessionid;

        this.users[apikey] = user;
        session.user = user;

        return true;
    }

    checkAPIKey(client, data) {
        if (!('X-API-KEY' in data)) {
            return false;
        }

        let apikey = data['X-API-KEY'];
        if (!(apikey in this.users)) {
            return false;
        }

        let user = this.users[apikey] || {};
        user.apikey = apikey;
        user.authenticated = true;
        user.clientid = client.id;
        this.users[apikey] = user;

        client.user = user;
        return true;
    }

    removeUser(user) {
        delete this.users[user.apikey];
    }
    getUserBySession(session) {
        return session.user;
    }
    getUserByClient(client) {
        return client.user;
    }
    getUser(apikey) {
        if (!(apikey in this.users))
            return null;
        return this.users[apikey];
    }
}

module.exports = new Authentication();
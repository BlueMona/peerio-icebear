const Keg = require('../kegs/keg');

class Quota extends Keg {
    constructor(db, user) {
        super('quotas', 'quotas', db, true);
        this.user = user;
    }

    deserializeKegPayload(data) {
        this.user.quota = data;
    }
}

module.exports = Quota;

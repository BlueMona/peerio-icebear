//
// User module tests
//

const User = require('../../src/models/user');
const helpers = require('../helpers');
const socket = require('../../src/network/socket');
// this is a sequenced test suite
describe('User model', () => {
    const user = new User();
    const userLogin = new User();

    before(function(done) {
        this.timeout(6000);
        user.username = userLogin.username = helpers.getRandomUsername();
        user.passphrase = userLogin.passphrase = 'such a secret passphrase';
        user.email = `${user.username}@mailinator.com`;
        socket.onceConnected(done);
    });

    it('#01 should server-validate username',
        () => User.validateUsername(user.username).then(available => available.should.be.true));

    it('#02 should register new user', function() {
        this.timeout(6000);
        return user.createAccountAndLogin();
    });

    it('#03 should login', function(done) {
        this.timeout(6000);
        socket.close();
        socket.onceConnected(() => userLogin.login()
                                            .then(() => done())
                                            .catch(err => done(new Error(err)))
                            );
        socket.open();
    });

    it('#04 should set and retrieve a passcode', () => {
        const passcode = 'this is fine';

        return user.getPasscodeSecret(passcode)
            .then((passcodeSecret) => {
                return user._getAuthDataFromPasscode(passcode, passcodeSecret);
            })
            .then((authData) => {
                return authData.passphrase.should.equal(user.passphrase);
            })
            .catch((err) => {
                throw err;
            });
    });
});

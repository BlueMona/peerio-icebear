const defineSupportCode = require('cucumber').defineSupportCode;
const getAppInstance = require('../../helpers/appConfig');
const { when } = require('mobx');
// const { receivedEmailInvite, confirmUserEmail } = require('../../helpers/mailinatorHelper');
// const runFeature = require('../../helpers/runFeature');
// const { getRandomUsername } = require('../../helpers/usernameHelper');
const { asPromise } = require('../../../../src/helpers/prombservable');

defineSupportCode(({ Before, Then, When }) => {
    // const store;
    const app = getAppInstance();
    const store = app.chatStore;
    const other = 'o6gl796m7ctzbv2u7nij74k1w5gqyi';

    Before((testCase, done) => {
        // const app = getAppInstance();
        // store = app.chatStore;
        when(() => app.socket.connected, done);
    });

    // Scenario: Create direct message
    When('I create a direct message', () => {
        const contactFromUsername = app.contactStore.getContact(other);
        return asPromise(contactFromUsername, 'loading', false)
            .then(() => {
                const chat = store.startChat([contactFromUsername]);
                return asPromise(chat, 'added', true);
            });
    });

    Then('the receiver gets notified', (done) => {
        store.loadAllChats()
            .then(() => {
                when(() => store.myChats.loaded, () => {
                    console.log(store.chats.length);
                    console.log(store.chats.map(x => console.log(x)));
                    done();
                });
            });
    });
});

const { observable, when } = require('mobx');
const Contact = require('../models/contact');

/**
 * Contact(Peerio user) information store.
 * Currently provides access to any public profiles and caches lookups.
 */
class ContactStore {
    /** @type {Array<Contact>} - A list of Contact objects that were requested in current session. (cache) */
    @observable contacts = [];

    /**
     * Returns Contact object ether from cache or server.
     * Reactive.
     * @param {string} username
     * @returns {Contact}
     */
    getContact(queryString) {
        const existing = this._findInCache(queryString);
        if (existing) return existing;

        const c = new Contact(queryString);
        this.contacts.unshift(c);
        when(() => !c.loading, () => {
            if (c.notFound) {
                this.contacts.remove(c);
            } else {
                for (const contact of this.contacts) {
                    if (contact.username === c.username && contact !== c) {
                        this.contacts.remove(contact);
                    }
                }
            }
        });
        return c;
    }

    // todo map
    _findInCache(username) {
        for (const contact of this.contacts) {
            if (contact.username === username) return contact;
        }
        return null;
    }

    // /**
    //  * Deletes contacts that were not found on server from store.
    //  */
    // @action removeInvalidContacts() {
    //     for (const c of this.contacts) {
    //         if (c.notFound) this.contacts.remove(c);
    //     }
    // }
}


module.exports = new ContactStore();

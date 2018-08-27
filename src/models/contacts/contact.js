const socket = require('../../network/socket');
const { observable, action, when, computed, reaction } = require('mobx');
const { cryptoUtil } = require('../../crypto/index');
const { getUser } = require('./../../helpers/di-current-user');
const Tofu = require('./tofu');
const tofuStore = require('./tofu-store');
const { getFirstLetterUpperCase } = require('./../../helpers/string');
const serverSettings = require('../server-settings');
const { t } = require('peerio-translator');
const clientApp = require('../client-app');
const { getContactStore } = require('../../helpers/di-contact-store');
const ContactColors = require('./contact.colors');

const nullFingerprint = '00000-00000-00000-00000-00000-00000';

/**
 * Contact object represents any Peerio user, including currently authenticated user.
 *
 * Possible states and how to read them:
 * loading === true - trying to load contact, will make many attempts in case of connection issues
 * loading === false && notFound === false - success
 * loading === false && notFound === true  - fail
 * @param {string} username - this can also be an email which will be replaced with username if user found
 * @param {Object} [prefetchedData] - if, for some reason you have the contact data from server, feed it here
 * @param {bool} [noAutoLoad] - don't automatically call this.load() in constructor (needed for tests only)
 */
class Contact {
    constructor(username, prefetchedData, noAutoLoad) {
        this.username = username.toLowerCase();
        if (getUser().username === this.username) this.isMe = true;
        this.usernameTag = `@${this.username}`;
        if (this.isMe) {
            this.usernameTag += ` (${t('title_you')})`;
            reaction(
                () => getUser().firstName,
                n => {
                    this.firstName = n;
                }
            );
            reaction(
                () => getUser().lastName,
                n => {
                    this.lastName = n;
                }
            );
        }
        if (!noAutoLoad) this.load(prefetchedData);
    }

    /**
     * This flag means that we are making attempts to load contact
     * once it's 'false' it means that we are done trying with ether positive (notFound=false) result
     * or negative result. It's set to true by default, right after it exits constructor.
     * @type {boolean}
     */
    @observable loading = true; // default state, because that's what we do from the moment contact is created
    /**
     * @type {string}
     */
    username;
    /**
     * '@username'
     * @type {string}
     */
    usernameTag;
    /**
     * @type {array<string>}
     */
    addresses = [];
    /**
     * @type {string}
     */
    @observable firstName = '';
    /**
     * @type {string}
     */
    @observable lastName = '';
    /**
     * @type {Uint8Array}
     */
    @observable encryptionPublicKey = null;
    /**
     * @type {Uint8Array}
     */
    @observable signingPublicKey = null;
    /**
     * @type {boolean}
     */
    @observable tofuError = false;
    /**
     * Wether or not user added this contact to his address book
     * @type {boolean}
     */
    @observable isAdded = false;
    /**
     * Some server-generated random chars to prevent enumeration of user-specific urls
     * @type {string}
     */
    @observable urlSalt = null;
    /**
     * @type {number}
     */
    @observable profileVersion = 0;
    /**
     * @type {boolean}
     */
    @observable hasAvatar = false;
    /**
     * @type {boolean}
     */
    @observable isDeleted = false;
    /**
     * @type {boolean}
     */
    @observable isHidden = false;
    /**
     * @type {string}
     */
    appLabel;

    /**
     * RGB string built based on hashed signing public key, not cryptographically strong, just for better UX
     * @type {string}
     */
    @computed
    get color() {
        if (!this.signingPublicKey) return { value: '#e0e1e6', isLight: true };
        const int = this.signingPublicKey[0] % ContactColors.length;
        return ContactColors[int];
    }

    /**
     * First letter of first name or username.
     * @type {string}
     */
    @computed
    get letter() {
        return getFirstLetterUpperCase(this.firstName || this.username);
    }

    /**
     * @type {string}
     */
    @computed
    get fullName() {
        let ret = '';
        if (this.firstName) ret = this.firstName;
        if (this.lastName) {
            if (ret) ret += ' ';
            ret += this.lastName;
        }
        return ret;
    }

    /**
     * @type {string}
     */
    @computed
    get fullNameAndUsername() {
        let ret = '';
        if (this.firstName) ret = this.firstName;
        if (this.lastName) {
            if (ret) ret += ' ';
            ret += this.lastName;
        }
        if (ret) ret += ' ';
        ret += `(${this.username})`;
        return ret;
    }

    /**
     * Lower cased full name for search/filter optimization
     * @type {string}
     */
    @computed
    get fullNameLower() {
        return this.fullName.toLocaleLowerCase();
    }

    // fingerprint calculation is async, but at the same time we want it to be lazy computed
    // so we cache computed result here
    @observable __fingerprint = null;
    // but we also want to make sure computed will be refreshed on signing key change
    // so we remember which key was used
    __fingerprintKey;
    /**
     * Cryptographically strong User fingerprint based on signing public key.
     * Looks like '12345-12345-12345-12345-12345', empty value is '00000-00000-00000-00000-00000-00000'
     * @type {string}
     */
    @computed
    get fingerprint() {
        if (!this.signingPublicKey) return nullFingerprint;
        if (!this.__fingerprint || this.__fingerprintKey !== this.signingPublicKey) {
            this.__fingerprintKey = this.signingPublicKey;
            cryptoUtil.getFingerprint(this.username, this.signingPublicKey).then(f => {
                this.__fingerprint = f;
            });

            return nullFingerprint;
        }
        return this.__fingerprint;
    }

    @computed
    get _avatarUrl() {
        return `${serverSettings.avatarServer}/v2/avatar/${this.urlSalt}`;
    }
    /**
     * @type {string}
     */
    @computed
    get largeAvatarUrl() {
        if (!this.hasAvatar) return null;
        return `${this._avatarUrl}/large/?${this.profileVersion}`;
    }
    /**
     * @type {string}
     */
    @computed
    get mediumAvatarUrl() {
        if (!this.hasAvatar) return null;
        // todo: returning large size here to deal with 64px upscaling to 80px on retina mess
        return `${this._avatarUrl}/large/?${this.profileVersion}`;
    }

    /**
     * Same as {@link fingerprint}, but formatted as: '1234 5123 4512\n3451 2345 1234 5123 45'
     * @type {string}
     */
    @computed
    get fingerprintSkylarFormatted() {
        let i = 0;
        return this.fingerprint
            .replace(/-/g, '')
            .match(/.{1,5}/g)
            .join(' ')
            .replace(/ /g, () => (i++ === 2 ? '\n' : ' '));
    }

    /**
     * Server said it couldn't find this user.
     * @type {boolean}
     */
    @observable notFound = false;

    // to avoid parallel queries
    _waitingForResponse = false;

    // {username: string, resolve: function, reject: function}
    static smartRequestQueue = [];
    static smartRequestTimer = null;
    static lastTimerInterval = 0;
    static lastAdditionTime = 0;
    static smartRequestStartExecutor() {
        if (Contact.smartRequestTimer) return;
        Contact.lastTimerInterval = clientApp.updatingAfterReconnect ? 2000 : 300;
        console.log('Starting batch executor with interval', Contact.lastTimerInterval);
        Contact.smartRequestTimer = setInterval(
            Contact.smartRequestExecutor,
            Contact.lastTimerInterval
        );
    }

    static smartRequestExecutor() {
        if (
            Date.now() - Contact.lastAdditionTime < Contact.lastTimerInterval &&
            Contact.smartRequestQueue.length < 50
        )
            return;
        if (!Contact.smartRequestQueue.length) {
            clearInterval(Contact.smartRequestTimer);
            Contact.smartRequestTimer = null;
            return;
        }
        const usernames = Contact.smartRequestQueue.splice(0, 50); // 50 - max allowed batch size on server
        console.log(`Batch requesting ${usernames.length} lookups`);
        socket
            .send('/auth/user/lookup', { string: usernames.map(u => u.username) }, false)
            .then(res => {
                for (let i = 0; i < usernames.length; i++) {
                    usernames[i].resolve([res[i]]);
                }
            })
            .catch(err => {
                console.error(err);
                usernames.forEach(u => u.reject(err));
            });
    }

    static smartRequest(username) {
        return new Promise((resolve, reject) => {
            Contact.smartRequestQueue.push({ username, resolve, reject });
            Contact.lastAdditionTime = Date.now();
            Contact.smartRequestStartExecutor();
        });
    }

    /**
     * Loads user data from server (or applies prefetched data)
     * @param {Object} [prefetchedData]
     */
    load(prefetchedData) {
        if (!this.loading || this._waitingForResponse) return;
        // console.log(`Loading contact: ${this.username}`);
        this.loading = true;
        this._waitingForResponse = true;

        (prefetchedData ? Promise.resolve(prefetchedData) : Contact.smartRequest(this.username))
            .then(
                action(resp => {
                    const profile = (resp && resp[0] && resp[0][0] && resp[0][0].profile) || null;
                    if (!profile) {
                        this.notFound = true;
                        this._waitingForResponse = false;
                        this.loading = false;
                        return;
                    }
                    this.username = profile.username;
                    this.usernameTag = `@${this.username}`;
                    this.appLabel = profile.appLabel || 'peerio';
                    this.firstName = profile.firstName || '';
                    this.lastName = profile.lastName || '';
                    this.urlSalt = profile.urlSalt;
                    this.hasAvatar = profile.hasAvatar;
                    this.isDeleted = !!profile.isDeleted;
                    this.addresses = profile.addresses || [];
                    this.mentionRegex = new RegExp(`@${this.username}`, 'gi');
                    this.profileVersion = profile.profileVersion || 0;
                    this.mcrRoles = profile.props ? profile.props.mcrRoles : null;

                    // this is server - controlled data, so we don't account for cases when it's invalid
                    this.encryptionPublicKey = new Uint8Array(profile.encryptionPublicKey);
                    this.signingPublicKey = new Uint8Array(profile.signingPublicKey);
                    // HINT: not calling loadTofu automatically anymore
                    this._waitingForResponse = false;
                    this.loading = false;
                })
            )
            .catch(err => {
                this._waitingForResponse = false;
                if (!prefetchedData) {
                    setTimeout(() => {
                        socket.onceAuthenticated(() => this.load());
                    }, 3000);
                }
                console.log(err);
            });
    }

    /**
     * Loads or creates Tofu keg and verifies Tofu data, check `tofuError` observable.
     * @returns {Promise}
     */
    loadTofu() {
        // console.log('Loading tofu:', this.username);
        return tofuStore.getByUsername(this.username).then(
            action(tofu => {
                this._waitingForResponse = false;
                this.loading = false;
                if (!tofu) {
                    const newTofu = new Tofu(getUser().kegDb);
                    newTofu.username = this.username;
                    newTofu.firstName = this.firstName;
                    newTofu.lastName = this.lastName;
                    newTofu.encryptionPublicKey = cryptoUtil.bytesToB64(this.encryptionPublicKey);
                    newTofu.signingPublicKey = cryptoUtil.bytesToB64(this.signingPublicKey);
                    // todo: this has a potential of creating 2+ tofu kegs for same contact
                    // todo: add checks similar to receipt keg dedupe
                    return newTofu.saveToServer();
                }
                // flagging contact
                if (
                    tofu.encryptionPublicKey !== cryptoUtil.bytesToB64(this.encryptionPublicKey) ||
                    tofu.signingPublicKey !== cryptoUtil.bytesToB64(this.signingPublicKey)
                ) {
                    this.tofuError = true;
                }
                // overriding whatever server returned for contact with our stored keys
                // so crypto operations will fail in case of difference
                // todo: this works only until we implement key change feature
                this.encryptionPublicKey = cryptoUtil.b64ToBytes(tofu.encryptionPublicKey);
                this.signingPublicKey = cryptoUtil.b64ToBytes(tofu.signingPublicKey);
                return null;
            })
        );
    }

    /**
     * Helper function to execute callback when contact is loaded.
     * Executes immediately if already loaded.
     * @param {function} callback
     */
    whenLoaded(callback) {
        // it is important for this to be async
        when(
            () => !this.loading && getContactStore().myContacts.loaded,
            () => setTimeout(() => callback(this))
        );
    }
    /**
     * Helper function to get a promise that resolves when contact is loaded.
     * @returns {Promise}
     */
    ensureLoaded() {
        return new Promise(resolve => {
            this.whenLoaded(resolve);
        });
    }
    /**
     * Helper function to get a promise that resolves when all contacts in passed collection are loaded.
     * @param {Array<Contact>} contacts
     * @returns {Promise}
     */
    static ensureAllLoaded(contacts) {
        return Promise.map(contacts, contact => contact.ensureLoaded());
    }
}

module.exports = Contact;


const Profile = require('./profile');
const Quota = require('./quota');
const Settings = require('./settings');
const tracker = require('../update-tracker');
const { retryUntilSuccess } = require('../../helpers/retry.js');
const warnings = require('../warnings');
const socket = require('../../network/socket');
const validators = require('../../helpers/validation/field-validation').validators;
const contactStore = require('../contacts/contact-store');

module.exports = function mixUserRegisterModule() {
    const _profileKeg = new Profile(this);
    const _quotaKeg = new Quota(this);
    this.settings = new Settings(this);

    this.loadSettings = () => {
        loadSimpleKeg(this.settings);
    };

    this.saveSettings = () => {
        return this.settings.saveToServer().tapCatch(err => {
            console.error(err);
            warnings.add('error_saveSettings');
        });
    };

    this.loadProfile = () => {
        loadSimpleKeg(_profileKeg);
    };

    this.loadQuota = () => {
        loadSimpleKeg(_quotaKeg);
    };

    function loadSimpleKeg(keg) {
        const digest = tracker.getDigest('SELF', keg.type);
        if (digest.maxUpdateId !== '' && digest.maxUpdateId <= keg.collectionVersion) {
            if (digest.maxUpdateId !== digest.knownUpdateId) {
                tracker.seenThis('SELF', keg.type, digest.maxUpdateId);
            }
            return;
        }
        retryUntilSuccess(() => keg.load().then(() => loadSimpleKeg(keg)), `${keg.type} Load`);
    }

    // will be triggered first time after login
    tracker.onKegTypeUpdated('SELF', 'profile', this.loadProfile);
    tracker.onKegTypeUpdated('SELF', 'quotas', this.loadQuota);
    tracker.onKegTypeUpdated('SELF', 'settings', this.loadSettings);

    this.saveProfile = function() {
        return _profileKeg.saveToServer().tapCatch(err => {
            console.error(err);
            warnings.add('error_saveSettings');
        });
    };

    this.resendEmailConfirmation = function(email) {
        return socket.send('/auth/address/resend-confirmation', {
            address: {
                type: 'email',
                value: email
            }
        })
            .then(() => {
                warnings.add('warning_emailConfirmationResent');
            })
            .tapCatch(err => {
                console.error(err);
                warnings.add('error_resendConfirmation');
            });
    };

    this.removeEmail = function(email) {
        return socket.send('/auth/address/remove', {
            address: {
                type: 'email',
                value: email
            }
        }).tapCatch(err => {
            console.error(err);
            warnings.add('error_saveSettings');
        });
    };

    this.addEmail = function(email) {
        return validators.emailAvailability.action(email).then(available => {
            if (!available) {
                warnings.addSevere('error_emailTaken', 'title_error');
                return Promise.resolve();
            }
            return socket.send('/auth/address/add', {
                address: {
                    type: 'email',
                    value: email
                }
            })
                .then(() => {
                    warnings.add('warning_emailConfirmationSent');
                });
        }).tapCatch(err => {
            console.error(err);
            warnings.add('error_saveSettings');
        });
    };

    this.makeEmailPrimary = function(email) {
        return socket.send('/auth/address/make-primary', {
            address: {
                type: 'email',
                value: email
            }
        }).tapCatch(err => {
            console.error(err);
            warnings.add('error_saveSettings');
        });
    };

    // todo: move to quota keg, make computed
    this.canSendGhost = function() {
        const q = this.quota;
        if (q && q.quotasLeft && q.quotasLeft.ghost) {
            const qTotal = q.quotasLeft.ghost.find(i => i.period === 'monthly');
            if (!qTotal) return true;
            return qTotal.limit > 0;
        }
        return true;
    };
    /**
     * Pass null to delete avatar
     */
    this.saveAvatar = function(blobs) {
        if (this.savingAvatar) return Promise.reject(new Error('Already saving avatar, wait for it to finish.'));

        if (blobs) {
            if (blobs.length !== 2) return Promise.reject(new Error('Blobs array length should be 2.'));
            for (let i = 0; i < blobs.length; i++) {
                if (blobs[i] instanceof ArrayBuffer) continue;
                return Promise.reject(new Error('Blobs should be of ArrayBuffer type'));
            }
        }
        this.savingAvatar = true;
        return retryUntilSuccess(() => {
            return socket.send('/auth/avatar/update', {
                large: blobs ? blobs[0] : null,
                medium: blobs ? blobs[1] : null
            });
        }).finally(() => {
            const c = contactStore.getContact(this.username);
            c.profileVersion++;
            c.hasAvatar = !!blobs;
            this.savingAvatar = false;
        });
    };
    this.deleteAvatar = function() {
        this.saveAvatar(null);
    };
};

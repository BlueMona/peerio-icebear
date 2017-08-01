/**
 * Observable/Promise bridges and tools
 * @module helpers/prombservable
 * @protected
 */
const { when } = require('mobx');

/**
 * Makes a promise out of observable.
 * @param {Object} object - any object
 * @param {string} observableProperty - observable property name inside object
 * @param {any} expectedValue - resolve promise when observable property has this value (strict equality ===)
 * @returns {Promise}
 * @memberof helpers/prombservable
 * @protected
 */
function asPromise(object, observableProperty, expectedValue) {
    return new Promise(resolve => {
        when(() => object[observableProperty] === expectedValue, setTimeout(resolve));
    });
}

module.exports = { asPromise };

/**
 * Various utility functions that didn't fit anywhere else.
 * @module util
 * @public
 */

// jsdoc (or documentationjs?) freaks out and pulls param from the next function
// unless this useless variable is defined
let a;// eslint-disable-line

/**
 * Finds all ArrayBuffer type properties recursively and changes them to Uint8Array created with the same ArrayBuffer.
 * @param {object} obj - object to check for ArrayBuffers.
 * @returns {object} same object that was passed but with some property values changed.
 * @memberof util
 * @public
 */
function convertBuffers(obj) {
    if (typeof (obj) !== 'object') return obj;

    for (const prop in obj) {
        const type = typeof (obj[prop]);
        if (type !== 'object') {
            continue;
        }
        if (obj[prop] instanceof ArrayBuffer) {
            obj[prop] = new Uint8Array(obj[prop]);
        } else {
            convertBuffers(obj[prop]);
        }
    }
    return obj;
}

/**
 * Converts bytes number to human-readable string format.
 * @param {number} bytes
 * @returns {string} formatted string.
 * @example
 * formatBytes(1024); // returns '1 KB'
 * @memberof util
 * @public
 */
function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    else if (bytes < 1048576) return `${+(bytes / 1024).toFixed(2)} KB`;
    else if (bytes < 1073741824) return `${+(bytes / 1048576).toFixed(2)} MB`;
    return `${+(bytes / 1073741824).toFixed(2)} GB`;
}

module.exports = { convertBuffers, formatBytes };


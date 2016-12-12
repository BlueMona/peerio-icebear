const { AbstractCallError } = require('../errors');
/**
 * Abstract File Stream class, inherit you own, override following functions
 * - open()
 * - close()
 * - readInternal()
 * - writeInternal()
 */
class FileStreamAbstract {

    /**
     * @param {string} filePath - will be used by 'open' function
     * @param {string} mode - 'read' or 'write'
     * @param {number} bufferSize
     */
    constructor(filePath, mode, bufferSize = 1024 * 512) {
        this.filePath = filePath;
        if (mode !== 'read' && mode !== 'write') {
            throw new Error('Invalid stream mode.');
        }
        if (mode === 'read') {
            /** @type {Uint8Array} public interface read buffer */
            this.buffer = new Uint8Array(bufferSize);
        }
        this.mode = mode;
    }

    /**
     * Reads a chunk of data from file stream
     * @return {Promise<number>} - resolves with a number of bytes written to buffer
     */
    read = () => {
        if (this.mode !== 'read') {
            return Promise.reject(new Error('Attempt to read from write stream.'));
        }
        return this.readInternal();
    };

    readInternal() {
        throw new AbstractCallError();
    }

    /**
     * Writes a chunk of data to file stream
     * @param {Uint8Array} buffer
     * @returns {Promise} - resolves when chunk is written out,
     */
    write = (buffer) => {
        if (this.mode !== 'write') return Promise.reject(new Error('Attempt to write to read stream.'));
        if (!buffer || !buffer.length) return Promise.resolve();
        return this.writeInternal(buffer);
    };

    // eslint-disable-next-line
    writeInternal(buffer, offset) {
        throw new AbstractCallError();
    }

    /**
     * @returns {Promise<number>} - resolves with file size when file is open and ready for reading/writing
     */
    open() {
        throw new AbstractCallError();
    }

    /**
     * Called when done working with file, should flush all buffers and dispose resources.
     */
    close() {
        throw new AbstractCallError();
    }

    /**
     * Are we using static cache directory to save downloaded files?
     */
    static useCache = false;

    /**
     * @returns {string} - actual device path
     */
    static cachePath(name) {
        throw new AbstractCallError();
    }

    /**
     * @returns Promise<boolean> - if path exists on device
     */
    static exists() {
        throw new AbstractCallError();
    }

    /**
     * Launch external viewer
     */
    static launchViewer(path) {
        throw new AbstractCallError();
    }

    // Set implementation from client app code
    static FileStream = null;
}

module.exports = FileStreamAbstract;

/**
 * Skynet's little brother who tries hard to remove bottlenecks in the whole
 * "read -> encrypt -> upload" process to maximize upload speed.
 */

const socket = require('../network/socket');
const errors = require('../errors');
const secret = require('../crypto/secret');

class FileUploader {
    // read chunks go here
    dataChunks = [];
    // encrypted chunks go here
    cipherChunks = [];

    // max data chunks in read queue
    dataChunksLimit = 3;
    // max data chunks in encrypt queue
    cipherChunksLimit = 2;

    // currently reading a chunk from file
    reading = false;
    // currently encrypting a chunk
    encrypting = false;
    // currently uploading a chunk
    uploading = false;
    // next queue processing calls will stop if stop == true
    stop = false;
    // end of file reached while reading file
    eofReached = false;
    // last chunk uploaded
    lastChunkSent = false;

    lastReadChunkId = -1;
    callbackCalled = false;

    /**
     * @param {File} file
     * @param {FileStream} stream
     * @param {FileNonceGenerator} nonceGenerator
     * @param {number} maxChunkId
     * @param {function} callback
     */
    constructor(file, stream, nonceGenerator, maxChunkId, callback) {
        this.file = file;
        this.stream = stream;
        this.nonceGenerator = nonceGenerator;
        this.maxChunkId = maxChunkId;
        this.callback = callback;
    }

    start() {
        this._tick();
    }

    _allDone() {
        return this.eofReached && !this.reading && !this.encrypting && !this.uploading
            && !this.dataChunks.length && !this.cipherChunks;
    }
    /**
     * Wrapper around callback call makes it asynchronous and prevents more then 1 call
     * @param {[Error]} err - in case there was an error
     */
    _callCallback(err) {
        if (this.callbackCalled) return;
        this.callbackCalled = true;
        setTimeout(() => this.callback(err));
    }

    _readChunk() {
        if (this.eofReached || this.stop || this.reading || this.dataChunks.length >= this.dataChunksLimit) return;
        this.reading = true;
        console.log(`${this.file.fileId}: reading next chunk ${this.lastReadChunkId + 1}`);
        this.stream.read()
            .then(bytesRead => {
                if (bytesRead === 0) {
                    this.eofReached = true;
                    if (this.lastReadChunkId !== this.maxChunkId) {
                        const err = new Error(`Was able to read up to ${this.lastReadChunkId}` +
                                                `chunk id, but max chunk id is${this.maxChunkId}`);
                        console.log(err);
                        console.log(`Upload failed for file ${this.file.fileId}`);
                        this.stop = true;
                        this._callCallback(err);
                    }
                } else {
                    let buffer = this.stream.buffer;
                    if (bytesRead !== buffer.length) {
                        buffer = buffer.slice(0, bytesRead);
                    }
                    this.dataChunks.push({ id: ++this.lastReadChunkId, buffer });
                }
                this.reading = false;
                this._tick();
            })
            .catch(err => {
                console.log(`Failed reading file ${this.file.fileId}. Upload filed.`, err);
                this.stop = true;
                this._callCallback(errors.normalize(err));
            });
    }

    _encryptChunk() {
        if (this.stop || this.encrypting || this.cipherChunks.length >= this.cipherChunksLimit
                || !this.dataChunks.length) return;
        this.encrypting = true;
        const chunk = this.dataChunks.shift();
        console.log(`${this.file.fileId}: encrypting next chunk ${chunk.id}`);
        chunk.buffer = secret.encrypt(chunk.buffer, this.file.key,
                                      this.nonceGenerator.getNextNonce(chunk.id === this.maxChunkId),
                                      false, true);
        this.cipherChunks.push(chunk);
        this.encrypting = false;
        this.file.progressBuffer = Math.ceil(
            (chunk.id + 1 + this.cipherChunks.length) / ((this.maxChunkId + 1) / 100));
        this._tick();
    }

    _uploadChunk() {
        if (this.stop || this.uploading || !this.cipherChunks.length) return;
        this.uploading = true;
        const chunk = this.cipherChunks.shift();
        console.log(`${this.file.fileId}: uploading next chunk ${chunk.id}`);
        socket.send('/auth/dev/file/upload-chunk', {
            fileId: this.file.fileId,
            chunkNum: chunk.id,
            chunk: chunk.buffer.buffer,
            last: chunk.id === this.maxChunkId
        }).then(() => {
            this.lastChunkSent = chunk.id === this.maxChunkId;
            this.uploading = false;
            this.file.progress = Math.floor((chunk.id + 1) / ((this.maxChunkId + 1) / 100));
            this._tick();
        }).catch(err => {
            console.log(`Failed uploading file ${this.file.fileId}. Upload filed.`, err);
            this.stop = true;
            this._callCallback(errors.normalize(err));
        });
    }

    _checkIfFinished() {
        if (this._allDone() || this.lastChunkSent) {
            if (!this._allDone() || !this.lastChunkSent) {
                console.error(`State discrepancy during file upload. ${this.toString()}`);
                return;
            }
            console.log(`Successfully done uploading file: ${this.file.fileId}`, this.toString());
            this._callCallback();
        }
    }

    toString() {
        return JSON.stringify({
            fileId: this.file.fileId,
            dataChunksLength: this.dataChunks.length,
            cipherChunksLength: this.cipherChunks.length,
            reading: this.reading,
            encrypting: this.encrypting,
            uploading: this.uploading,
            stop: this.stop,
            eofReached: this.eofReached,
            lastChunkSent: this.lastChunkSent,
            lastReadChunkId: this.lastReadChunkId,
            maxChunkId: this.maxChunkId,
            callbackCalled: this.callbackCalled
        });
    }

    _tick = () => {
        setTimeout(() => {
            try {
                this._readChunk();
                this._encryptChunk();
                this._uploadChunk();
                setTimeout(() => this._checkIfFinished());
            } catch (err) {
                console.log(`Upload failed for ${this.file.fileId}`, err, this.toString());
                this.stop = true;
                this._callCallback(errors.normalize(err));
            }
        });
    }

}


module.exports = FileUploader;
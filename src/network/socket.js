
/**
 * Main SocketClient singleton instance
 * @module network/socket
 */

const SocketClient = require('./socket-client');
const config = require('../config');

const socket = new SocketClient();

const wrappedStart = socket.start;

socket.start = function() {
    wrappedStart.call(socket, config.socketServerUrl);
};


module.exports = function(s) {



    
    return s || socket;
};

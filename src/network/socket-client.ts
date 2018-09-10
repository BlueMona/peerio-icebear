//
// WebSocket client module.
// This module exports SocketClient class that can be instantiated as many times as needed.
//

import { ServerError, serverErrorCodes, DisconnectedError, NotAuthenticatedError } from '../errors';
import io from 'socket.io-client/dist/socket.io';
import { observable } from 'mobx';
import config from '../config';
import Timer from '../helpers/observable-timer';
import { getUser } from '../helpers/di-current-user';
import TaskPacer from '../helpers/task-pacer';

interface ManagerExt extends SocketIOClient.Manager {
    backoff: any; // usage of this should go away with reconnect logic fix
    engine: any; // this is used only for debugging
}

interface SocketExt extends SocketIOClient.Socket {
    // We need access to these internals bcs socket.io thinks it can queue messages and send them right
    // after reconnect. In our reality those messages are likely to need an authenticated connection.
    sendBuffer: any[];
    receiveBuffer: any[];
    io: ManagerExt;
    binary: (hasBinaryProps: boolean) => SocketExt;
}

enum STATES {
    open = 'open',
    opening = 'opening',
    closed = 'closed',
    closing = 'closing'
}

// socket.io events
/* eslint-disable camelcase */
enum SOCKET_EVENTS {
    connect = 'connect',
    connect_error = 'connect_error',
    connect_timeout = 'connect_timeout',
    connecting = 'connecting',
    disconnect = 'disconnect',
    error = 'error',
    reconnect = 'reconnect',
    reconnect_attempt = 'reconnect_attempt',
    reconnect_failed = 'reconnect_failed',
    reconnect_error = 'reconnect_error',
    reconnecting = 'reconnecting',
    ping = 'ping',
    pong = 'pong',
    authenticated = 'authenticated'
}
/* eslint-enable camelcase */

// application events sent by app server
enum APP_EVENTS {
    digestUpdate = 'digestUpdate',
    serverWarning = 'serverWarning',
    // clearWarning= 'clearWarning',
    channelInvitesUpdate = 'channelInvitesUpdate',
    channelDeleted = 'channelDeleted',
    volumeDeleted = 'volumeDeleted',
    fileMigrationUnlocked = 'fileMigrationUnlocked',
    volumeInvitesUpdate = 'volumeInvitesUpdate'
}

/**
 * Use socket.js to get the default instance of SocketClient, unless you do need a separate connection for some reason.
 *
 * SocketClient emits many events, main ones are:
 * - **started** - whenever socket.start() is called the first time.
 * - **connect** - every time connection has been established.
 * - **authenticated** - when connection is fully authenticated and ready to work.
 * - **disconnect** - every time connection has been broken.
 *
 * The rest you can find in sources:
 * - **SOCKET_EVENTS** - whatever is happening with socket.io instance
 * - **APP_EVENTS** - server emits them
 */
export default class SocketClient {
    /**
     * Socket.io client instance
     */
    socket: SocketExt = null;
    taskPacer = new TaskPacer(20); // todo: maybe move to config
    /**
     * Was socket started or not
     */
    started = false;
    /**
     * Connection url this socket uses. Readonly.
     */
    url = null;
    /**
     * Observable connection state.
     */
    @observable connected = false;
    /**
     * This flag means that connection has technically been authenticated from server's perspective,
     * but client is still initializing, loading boot keg and other important data needed before starting any other
     * processes and setting socket.authenticated to true.
     */
    preauthenticated = false;
    /**
     * Observable. Normally you want to use socket when it's authenticated rather then just connected.
     */
    @observable authenticated = false;
    /**
     * Observable. Is the connection currently throttled by server.
     */
    @observable throttled = false;
    /**
     * Observable. In case reconnection attempt failed, this property will reflect current attempt number.
     */
    @observable reconnectAttempt = 0;
    /**
     * Observable. Shows current server response time in milliseconds. This is not a network ping,
     * this is a time needed for a websocket message to do a round trip.
     */
    @observable latency = 0;
    /**
     * Countdown to the next reconnect attempt.
     */
    reconnectTimer = new Timer();

    /**
     * Just an incrementing with every request number to be able to identify server responses.
     */
    requestId = 0;
    /**
     * Awaiting requests map.
     */
    awaitingRequests = {}; // {number: function}

    /**
     * List of 'authenticated' event handlers.
     */
    authenticatedEventListeners = [];
    /**
     * List of 'started' event handlers.
     */
    startedEventListeners = [];
    // following properties are not static for access convenience
    /**
     * Possible connection states
     */
    STATES = STATES;
    /**
     * Socket lifecycle events
     */
    SOCKET_EVENTS = SOCKET_EVENTS;
    /**
     * Application server events
     */
    APP_EVENTS = APP_EVENTS;

    backoffAttempts: number;
    _originalWSSend: typeof WebSocket.prototype.send;
    handleReconnectError: () => void;
    resetting: boolean;
    /**
     * Initializes the SocketClient instance, creates wrapped socket.io instance and so on.
     */
    start(url: string) {
        if (this.started) return;
        console.log(`Starting socket: ${url}`);
        if (!url) {
            console.error('Socket server url missing, can not start');
            return;
        }
        this.url = url;
        this.started = true;
        this.preauthenticated = false;
        this.authenticated = false;
        // <DEBUG>
        if (config.debug && config.debug.socketLogEnabled) {
            const s = (this._originalWSSend = WebSocket.prototype.send);
            WebSocket.prototype.send = function(msg) {
                if (config.debug.socketLogEnabled && typeof msg === 'string') {
                    console.log('⬆️ OUT MSG:', msg);
                }
                return s.call(this, msg);
            };
        }
        // </DEBUG>

        this.socket = io.connect(
            url,
            {
                reconnection: true,
                reconnectionAttempts: Infinity,
                reconnectionDelay: 500,
                reconnectionDelayMax: 9000,
                randomizationFactor: 0,
                timeout: 10000,
                autoConnect: false,
                transports: ['websocket'],
                forceNew: true
            }
        );
        // socket.io is weird, it caches data sometimes to send it to listeners after reconnect
        // but this is not working with authenticate-first connections.
        const clearBuffers = () => {
            this.socket.sendBuffer = [];
            this.socket.receiveBuffer = [];
        };

        this.socket.on('connect', () => {
            console.log('\ud83d\udc9a Socket connected.');
            clearBuffers();
            this.configureDebugLogger();
            this.connected = true;
        });

        this.socket.on('disconnect', () => {
            console.log('\ud83d\udc94 Socket disconnected.');
            this.preauthenticated = false;
            this.authenticated = false;
            this.connected = false;
            clearBuffers();
            this.cancelAwaitingRequests();
        });

        this.socket.on('reconnect_attempt', num => {
            if (this.backoffAttempts) {
                this.reconnectAttempt = this.backoffAttempts;
                this.socket.io.backoff.attempts = this.backoffAttempts;
                this.backoffAttempts = 0;
            } else {
                this.reconnectAttempt = num;
            }
        });

        this.socket.on('pong', latency => {
            this.latency = latency;
        });

        this.handleReconnectError = () => {
            // HACK: backoff.duration() will increase attempt count, so we balance that
            this.socket.io.backoff.attempts--;
            this.reconnectTimer.countDown(this.socket.io.backoff.duration() / 1000);
            this.socket.open();
        };

        this.socket.on('connect_error', this.handleReconnectError);
        this.socket.on('reconnect_error', this.handleReconnectError);
        this.socket.on('error', this.handleReconnectError);

        this.socket.open();

        this.startedEventListeners.forEach(l => setTimeout(l));
        this.startedEventListeners = [];
    }

    configureDebugLogger() {
        if (config.debug && config.debug.socketLogEnabled) {
            this.socket.io.engine.addEventListener('message', msg => {
                if (config.debug.socketLogEnabled && typeof msg === 'string') {
                    console.log('⬇️ IN MSG:', msg);
                }
            });
        }
    }

    /**
     * Returns connection state
     */
    get state(): string {
        // unknown states translated to 'closed' for safety
        return STATES[this.socket.io.readyState] || STATES.closed;
    }

    /**
     * Internal function to do what it says
     */
    setAuthenticatedState() {
        // timeout to make sure code that call this does what it needs to before mobx reaction triggers
        setTimeout(() => {
            if (this.state !== STATES.open) return;
            this.authenticated = true;
            this.authenticatedEventListeners.forEach(listener => {
                setTimeout(listener);
            });
        });
    }

    /**
     * Internal function to do what it says
     */
    validateSubscription(event, listener) {
        if (!SOCKET_EVENTS[event] && !APP_EVENTS[event]) {
            throw new Error('Attempt to un/subscribe from/to unknown socket event.');
        }
        if (!listener || typeof listener !== 'function') {
            throw new Error('Invalid listener type.');
        }
    }
    /**
     * Subscribes a listener to one of the socket or app events.
     * @param event - event name, one of SOCKET_EVENTS or APP_EVENTS
     * @param listener - event handler
     * @returns function you can call to unsubscribe
     */
    subscribe(event: SOCKET_EVENTS | APP_EVENTS, listener: (data?) => void): () => void {
        this.validateSubscription(event, listener);
        if (event === SOCKET_EVENTS.authenticated) {
            // maybe this listener was subscribed already
            if (this.authenticatedEventListeners.indexOf(listener) < 0) {
                this.authenticatedEventListeners.push(listener);
            }
        } else {
            this.socket.on(event, listener);
        }
        return () => this.unsubscribe(event, listener);
    }

    /**
     * Unsubscribes socket or app events listener.
     * @param event - event name, one of SOCKET_EVENTS or APP_EVENTS
     * @param listener - event handler
     */
    unsubscribe(event: SOCKET_EVENTS | APP_EVENTS, listener: () => void) {
        this.validateSubscription(event, listener);
        if (event === SOCKET_EVENTS.authenticated) {
            const ind = this.authenticatedEventListeners.indexOf(listener);
            if (ind < 0) return;
            this.authenticatedEventListeners.splice(ind, 1);
        } else {
            this.socket.off(event, listener);
        }
    }

    /**
     * Send a message to server
     * @param name - api method name
     * @param data - data to send
     * @param hasBinaryData - if you know for sure, set this to true/false to increase performance
     * @returns - server response, always returns `{}` if response is empty
     */
    send(name: string, data?: {}, hasBinaryData: boolean = null): Promise<any> {
        const id = this.requestId++;
        return (new Promise((resolve, reject) => {
            this.awaitingRequests[id] = { name, data, reject };
            this.taskPacer.run(() => {
                if (!this.awaitingRequests[id]) {
                    // promise timed out while waiting in queue
                    return;
                }
                if (!this.connected) {
                    console.error(`Attempt to send ${name} while disconnected`);
                    reject(new DisconnectedError());
                    return;
                }
                if (name.startsWith('/auth/') && !this.preauthenticated) {
                    console.error(`Attempt to send ${name} while not authenticated`);
                    reject(new NotAuthenticatedError());
                    return;
                }
                const handler = resp => {
                    this.throttled = resp.error === serverErrorCodes.accountThrottled;
                    if (resp && resp.error) {
                        if (resp.error === serverErrorCodes.accountClosed) {
                            getUser().deleted = true;
                            this.close();
                        }
                        if (resp.error === serverErrorCodes.accountBlacklisted) {
                            getUser().blacklisted = true;
                            this.close();
                        }
                        console.error(name, data, resp);
                        reject(new ServerError(resp.error, resp.message));
                        return;
                    }
                    resolve(resp);
                };
                // console.debug(id, name, data);
                if (hasBinaryData === null) {
                    this.socket.emit(name, data, handler);
                } else {
                    this.socket.binary(hasBinaryData).emit(name, data, handler);
                }
            }, name);
        }) as Promise<any>)
            .timeout(60000)
            .finally(() => {
                delete this.awaitingRequests[id];
            }) as Promise<any>;
    }

    /**
     * Rejects promises and clears all awaiting requests (in case of disconnect)
     */
    cancelAwaitingRequests() {
        const err = new DisconnectedError();
        for (const id in this.awaitingRequests) {
            const req = this.awaitingRequests[id];
            console.warn('Cancelling awaiting request', req.name, req.data);
            req.reject(err);
        }
        this.awaitingRequests = {};
    }

    /**
     * Executes a callback only once when socket will connect.
     * If socket is already connected, callback will be scheduled to run ASAP.
     */
    onceConnected(callback: () => void) {
        if (this.socket.connected) {
            setTimeout(callback, 0);
            return;
        }
        const handler = () => {
            setTimeout(callback, 0);
            this.unsubscribe(SOCKET_EVENTS.connect, handler);
        };
        this.subscribe(SOCKET_EVENTS.connect, handler);
    }

    /**
     * Executes a callback only once when socket will authenticate.
     * If socket is already authenticated, callback will be scheduled to run ASAP.
     */
    onceAuthenticated(callback: () => void) {
        if (this.authenticated) {
            setTimeout(callback, 0);
            return;
        }
        const handler = () => {
            setTimeout(callback, 0);
            this.unsubscribe(SOCKET_EVENTS.authenticated, handler);
        };
        this.subscribe(SOCKET_EVENTS.authenticated, handler);
    }
    onceDisconnected(callback: () => void) {
        if (!this.connected) {
            setTimeout(callback, 0);
            return;
        }
        const handler = () => {
            setTimeout(callback, 0);
            this.unsubscribe(SOCKET_EVENTS.disconnect, handler);
        };
        this.subscribe(SOCKET_EVENTS.disconnect, handler);
    }

    /**
     * Executes a callback once socket is started.
     * If socket is already started, callback will be scheduled to run ASAP.
     */
    onceStarted(callback: () => void) {
        if (this.started) {
            setTimeout(callback, 0);
            return;
        }
        this.startedEventListeners.push(callback);
    }

    /**
     * Shortcut to frequently used 'authenticated' subscription.
     * Does not call handler if socket is already authenticated, only subscribes to future events.
     * @returns unsubscribe function
     */
    onAuthenticated(handler: () => void): () => void {
        return this.subscribe(SOCKET_EVENTS.authenticated, handler);
    }

    /**
     * Shortcut to frequently used 'disconnect' subscription.
     * Does not call handler if socket is already disconnected, only subscribes to future events.
     * @returns unsubscribe function
     */
    onDisconnect(handler: () => void): () => void {
        return this.subscribe(SOCKET_EVENTS.disconnect, handler);
    }

    /**
     * Closes current connection and disables reconnects until open() is called.
     */
    close = () => {
        this.socket.close();
    };

    /**
     * Opens a new connection. (Or does nothing if already open)
     */
    open = () => {
        this.socket.open();
    };

    /**
     * Internal function to do what it says
     */
    resetReconnectTimer = () => {
        if (this.connected) return;
        this.backoffAttempts = this.socket.io.backoff.attempts;
        this.reset();
    };

    /**
     * Closes connection and opens it again.
     */
    reset = () => {
        if (this.resetting) return;
        this.resetting = true;

        this.reconnectTimer.stop();

        setTimeout(this.close);
        const interval = setInterval(() => {
            if (this.state !== STATES.closed) return;
            this.open();
            this.resetting = false;
            clearInterval(interval);
        }, 1000);
    };

    dispose() {
        this.taskPacer.clear();
        if (this._originalWSSend) WebSocket.prototype.send = this._originalWSSend;
    }
}
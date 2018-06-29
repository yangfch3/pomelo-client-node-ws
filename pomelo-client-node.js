const JS_WS_CLIENT_TYPE = 'js-websocket';
const JS_WS_CLIENT_VERSION = '0.0.1';

const WebSocket = require('ws');
const Protocol = require('pomelo-protocol');
const Protobuf = require('./lib/pomelo-protobuf/protobuf');
const decodeIO_protobuf = require('pomelo-decodeio-protobuf');
let decodeIO_encoder = null;
let decodeIO_decoder = null;
const Package = Protocol.Package;
const Message = Protocol.Message;
const EventEmitter = require('events');
const rsa = require('./lib/rsasign/rsa');
const localStorage = require('store');

const RES_OK = 200;
const RES_FAIL = 500;
const RES_OLD_CLIENT = 501;

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;

class Pomelo extends EventEmitter {
    constructor() {
        super();

        this.protobuf = new Protobuf();

        this.socket = null;
        this.reqId = 0;
        this.callbacks = {};
        this.handlers = {};
        //Map from request id to route
        this.routeMap = {};
        this.dict = {}; // route string to code
        this.abbrs = {}; // code to route string
        this.serverProtos = {};
        this.clientProtos = {};
        this.protoVersion = 0;

        this.heartbeatInterval = 0;
        this.heartbeatTimeout = 0;
        this.nextHeartbeatTimeout = 0;
        this.gapThreshold = 100; // heartbeat gap threashold
        this.heartbeatId = null;
        this.heartbeatTimeoutId = null;
        this.handshakeCallback = null;

        this.decode = null;
        this.encode = null;

        this.reconnect = false;
        this.reconncetTimer = null;
        this.reconnectUrl = null;
        this.reconnectAttempts = 0;
        this.reconnectionDelay = 5000;
        this.maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS;

        this.useCrypto = false;

        this.handshakeBuffer = {
            'sys': {
                type: JS_WS_CLIENT_TYPE,
                version: JS_WS_CLIENT_VERSION
            },
            'user': {}
        };

        this.initCallback = null;
    }

    init(params, cb) {
        this.handlers[Package.TYPE_HANDSHAKE] = this.handshake.bind(this);
        this.handlers[Package.TYPE_HEARTBEAT] = this.heartbeat.bind(this);
        this.handlers[Package.TYPE_DATA] = this.onData.bind(this);
        this.handlers[Package.TYPE_KICK] = this.onKick.bind(this);

        this.initCallback = cb;

        let host = params.host;
        let port = params.port;
        let scheme = params.scheme || 'ws';

        this.encode = params.encode || this.defaultEncode;
        this.decode = params.decode || this.defaultDecode;

        let url = scheme + '://' + host;
        if (port) {
            url += ':' + port;
        }

        this.handshakeBuffer.user = params.user;
        if (params.encrypt) {
            this.useCrypto = true;
            rsa.generate(1024, '10001');
            this.handshakeBuffer.sys.rsa = {
                rsa_n: rsa.n.toString(16),
                rsa_e: rsa.e
            };
        }
        this.handshakeCallback = params.handshakeCallback;
        this.connect(params, url, cb);
    }

    connect(params, url, cb) {
        let self = this;

        params = params || {};
        this.maxReconnectAttempts = params.maxReconnectAttempts || DEFAULT_MAX_RECONNECT_ATTEMPTS;
        this.reconnectUrl = url;
        //Add protobuf version
        if (localStorage.get('protos') && this.protoVersion === 0) {
            let protos = JSON.parse(localStorage.get('protos'));

            this.protoVersion = protos.version || 0;
            this.serverProtos = protos.server || {};
            this.clientProtos = protos.client || {};

            if (this.protobuf) {
                this.protobuf.init({
                    encoderProtos: this.clientProtos,
                    decoderProtos: this.serverProtos
                });
            }
            if (decodeIO_protobuf) {
                decodeIO_encoder = decodeIO_protobuf.loadJson(this.clientProtos);
                decodeIO_decoder = decodeIO_protobuf.loadJson(this.serverProtos);
            }
        }
        //Set protoversion
        this.handshakeBuffer.sys.protoVersion = this.protoVersion;

        let onopen = function () {
            if (self.reconnect) {
                self.emit('reconnect');
            } else {
                self.emit('connected');
            }
            self.reset();
            let obj = Package.encode(Package.TYPE_HANDSHAKE, Protocol.strencode(JSON.stringify(self.handshakeBuffer)));
            self.send(obj);
        };
        let onmessage = function (event) {
            self.processPackage(Package.decode(event.data), cb);
            // new package arrived, update the heartbeat timeout
            if (self.heartbeatTimeout) {
                self.nextHeartbeatTimeout = Date.now() + self.heartbeatTimeout;
            }
        };
        let onerror = function (event) {
            self.emit('io-error', event);
            console.error('socket error: ', event);
        };
        let onclose = function (event) {
            self.emit('close', event);
            self.emit('disconnect', event);
            console.error('socket close: ', event.target.url);
            if (params.reconnect && self.reconnectAttempts < self.maxReconnectAttempts) {
                self.reconnect = true;
                self.reconnectAttempts++;
                self.reconncetTimer = setTimeout(function () {
                    self.connect(params, self.reconnectUrl, cb);
                }, self.reconnectionDelay);
                self.reconnectionDelay *= 2;
            }
        };
        self.socket = new WebSocket(url);
        console.log('connect to ' + url);
        self.socket.binaryType = 'arraybuffer';
        self.socket.onopen = onopen.bind(this);
        self.socket.onmessage = onmessage.bind(this);
        self.socket.onerror = onerror.bind(this);
        self.socket.onclose = onclose.bind(this);
    }

    defaultDecode(data) {
        //probuff decode
        let msg = Message.decode(data);

        if (msg.id > 0) {
            msg.route = this.routeMap[msg.id];
            delete this.routeMap[msg.id];
            if (!msg.route) {
                return;
            }
        }

        msg.body = this.deCompose(msg);
        return msg;
    }

    defaultEncode(reqId, route, msg) {
        let type = reqId ? Message.TYPE_REQUEST : Message.TYPE_NOTIFY;

        //compress message by protobuf
        if (this.protobuf && this.clientProtos[route]) {
            msg = this.protobuf.encode(route, msg);
        } else if (decodeIO_encoder && decodeIO_encoder.lookup(route)) {
            let Builder = decodeIO_encoder.build(route);
            msg = new Builder(msg).encodeNB();
        } else {
            msg = Protocol.strencode(JSON.stringify(msg));
        }

        let compressRoute = 0;
        if (this.dict && this.dict[route]) {
            route = this.dict[route];
            compressRoute = 1;
        }

        return Message.encode(reqId, type, compressRoute, route, msg);
    }

    disconnect() {
        if (this.socket) {
            if (this.socket.disconnect) this.socket.disconnect();
            if (this.socket.close) this.socket.close();
            console.log('disconnect');
            this.socket = null;
        }

        if (this.heartbeatId) {
            clearTimeout(this.heartbeatId);
            this.heartbeatId = null;
        }
        if (this.heartbeatTimeoutId) {
            clearTimeout(this.heartbeatTimeoutId);
            this.heartbeatTimeoutId = null;
        }
    }

    reset() {
        this.reconnect = false;
        this.reconnectionDelay = 1000 * 5;
        this.reconnectAttempts = 0;
        clearTimeout(this.reconncetTimer);
    }

    request(route, msg, cb) {
        if (arguments.length === 2 && typeof msg === 'function') {
            cb = msg;
            msg = {};
        } else {
            msg = msg || {};
        }
        route = route || msg.route;
        if (!route) {
            return;
        }

        this.reqId++;
        this.sendMessage(this.reqId, route, msg);

        this.callbacks[this.reqId] = cb;
        this.routeMap[this.reqId] = route;
    }

    notify(route, msg) {
        msg = msg || {};
        this.sendMessage(0, route, msg);
    }

    sendMessage(reqId, route, msg) {
        if (this.useCrypto) {
            msg = JSON.stringify(msg);
            let sig = rsa.signString(msg, 'sha256');
            msg = JSON.parse(msg);
            msg['__crypto__'] = sig;
        }

        if (this.encode) {
            msg = this.encode(reqId, route, msg);
        }

        let packet = Package.encode(Package.TYPE_DATA, msg);
        this.send(packet);
    }

    send(packet) {
        if (this.socket) {
            this.socket.send(packet);
        }
    }

    heartbeat() {
        let self = this;
        if (!this.heartbeatInterval) {
            // no heartbeat
            return;
        }

        let obj = Package.encode(Package.TYPE_HEARTBEAT);
        if (this.heartbeatTimeoutId) {
            clearTimeout(this.heartbeatTimeoutId);
            this.heartbeatTimeoutId = null;
        }

        if (this.heartbeatId) {
            // already in a heartbeat interval
            return;
        }
        this.heartbeatId = setTimeout(function () {
            self.heartbeatId = null;
            self.send(obj);

            self.nextHeartbeatTimeout = Date.now() + self.heartbeatTimeout;
            self.heartbeatTimeoutId = setTimeout(function () {
              self.heartbeatTimeoutCb()
            }, self.heartbeatTimeout);
        }, this.heartbeatInterval);
    }

    heartbeatTimeoutCb() {
        let self = this
        let gap = this.nextHeartbeatTimeout - Date.now();
        if (gap > this.gapThreshold) {
            this.heartbeatTimeoutId = setTimeout(function () {
              self.heartbeatTimeoutCb()
            }, gap);
        } else {
            console.error('server heartbeat timeout');
            this.emit('heartbeat timeout');
            this.disconnect();
        }
    }

    handshake(data) {
        data = JSON.parse(Protocol.strdecode(data));
        if (data.code === RES_OLD_CLIENT) {
            this.emit('error', 'client version not fullfill');
            return;
        }

        if (data.code !== RES_OK) {
            this.emit('error', 'handshake fail');
            return;
        }

        this.handshakeInit(data);

        let obj = Package.encode(Package.TYPE_HANDSHAKE_ACK);
        this.send(obj);
        if (this.initCallback) {
            this.initCallback(this.socket);
        }
    }

    onData(data) {
        let msg = data;
        if (this.decode) {
            msg = this.decode(msg);
        }
        this.processMessage(msg);
    }

    onKick(data) {
        data = JSON.parse(Protocol.strdecode(data));
        this.emit('onKick', data);
    }

    processPackage(msgs) {
        if (Array.isArray(msgs)) {
            for (let i = 0; i < msgs.length; i++) {
                let msg = msgs[i];
                this.handlers[msg.type](msg.body);
            }
        } else {
            this.handlers[msgs.type](msgs.body);
        }
    }

    processMessage(msg) {
        if (!msg.id) {
            // server push message
            this.emit('__CLIENT_ROUTE', msg.route, msg.body);
            this.emit(msg.route, msg.body);
            return;
        }

        //if have a id then find the callback function with the request
        let cb = this.callbacks[msg.id];

        delete this.callbacks[msg.id];
        if (typeof cb !== 'function') {
            return;
        }

        cb(msg.body);
    }

    processMessageBatch(pomelo, msgs) {
        for (let i = 0, l = msgs.length; i < l; i++) {
            this.processMessage(msgs[i]);
        }
    }

    deCompose(msg) {
        let route = msg.route;

        //Decompose route from dict
        if (msg.compressRoute) {
            if (!this.abbrs[route]) {
                return {};
            }

            route = msg.route = this.abbrs[route];
        }
        if (this.protobuf && this.serverProtos[route]) {
            return this.protobuf.decodeStr(route, msg.body);
        } else if (decodeIO_decoder && decodeIO_decoder.lookup(route)) {
            return decodeIO_decoder.build(route).decode(msg.body);
        } else {
            return JSON.parse(Protocol.strdecode(msg.body));
        }
    }

    handshakeInit(data) {
        if (data.sys && data.sys.heartbeat) {
            this.heartbeatInterval = data.sys.heartbeat * 1000; // heartbeat interval
            this.heartbeatTimeout = this.heartbeatInterval * 2; // max heartbeat timeout
        } else {
            this.heartbeatInterval = 0;
            this.heartbeatTimeout = 0;
        }

        this.initData(data);

        if (typeof this.handshakeCallback === 'function') {
            this.handshakeCallback(data.user);
        }
    }

    //Initilize data used in pomelo client
    initData(data) {
        if (!data || !data.sys) {
            return;
        }
        let dict = data.sys.dict;
        let protos = data.sys.protos;

        //Init compress dict
        if (dict) {
            this.dict = dict;
            this.abbrs = {};

            for (let route in dict) {
                if (dict.hasOwnProperty(route)) {
                    this.abbrs[dict[route]] = route;
                }
            }
        }

        //Init protobuf protos
        if (protos) {
            this.protoVersion = protos.version || 0;
            this.serverProtos = protos.server || {};
            this.clientProtos = protos.client || {};

            //Save protobuf protos to localStorage
            localStorage.set('protos', JSON.stringify(protos));

            if (this.protobuf) {
                this.protobuf.init({
                    encoderProtos: protos.client,
                    decoderProtos: protos.server
                });
            }
            if (decodeIO_protobuf) {
                decodeIO_encoder = decodeIO_protobuf.loadJson(this.clientProtos);
                decodeIO_decoder = decodeIO_protobuf.loadJson(this.serverProtos);
            }
        }
    }
}

module.exports = Pomelo;

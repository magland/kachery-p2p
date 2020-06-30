import crypto from 'crypto';
import hyperswarm from 'hyperswarm';
import JsonSocket from 'json-socket';
import HPeerConnection from './HPeerConnection.js';
import { randomString, sleepMsec } from './util.js';

const PROTOCOL_VERSION = 'kachery-p2p-3'

class HSwarmConnection {
    constructor({nodeId, swarmName, verbose}) {
        this._nodeId = nodeId;
        this._swarmName = swarmName;
        this._verbose = verbose;
        const topicKey = {
            protocolVersion: PROTOCOL_VERSION,
            swarmName: swarmName
        };
        this._topic = crypto.createHash('sha256')
            .update(JSON.stringify(topicKey))
            .digest()
        this._topicHex = crypto.createHash('sha256')
            .update(JSON.stringify(topicKey))
            .digest('hex')
        this._hyperswarm = null;
        this._peerConnections = {};

        this._messageIdsHandled = {};
        this._onMessageCallbacks = [];
        this._messageListeners = {};

        this.onMessage(msg => {
            for (let id in this._messageListeners) {
                const x = this._messageListeners[id];
                if (x.testFunction(msg)) {
                    x.onMessageCallbacks.forEach(cb => {cb(msg);});
                }
            }
        })

        this._start();
    }
    async join() {
        if (this._verbose >= 1) {
            console.info(`joining hyperswarm: ${this._swarmName} ${this._topicHex}`)
        }
        this._hyperswarm = hyperswarm({
            forget: {
                // how long to wait before forgetting that a peer
                // has become unresponsive
                unresponsive: 3,
                // how long to wait before fogetting that a peer
                // has been banned
                banned: 3
            },
            multiplex: true
        });
        this._hyperswarm.join(this._topic, {
            lookup: true, // find & connect to peers
            announce: true // announce self as a connection target
        })
        // this._hyperswarm.on('peer', peer => {
        //     console.info(`${this._swarmName}: Peer discovered: ${peer.host}:${peer.port}${peer.local ? " (local)" : ""}`)
        // });
        this._hyperswarm.on('peer-rejected', peer => {
            if (this._verbose >= 0) {
                console.info(`${this._swarmName}: Peer rejected: ${peer.host}:${peer.port}${peer.local ? " (local)" : ""}`)
            }
        });
        this._hyperswarm.on('connection', (socket, details) => {
            const jsonSocket = new JsonSocket(socket);
            jsonSocket._socket = socket;
            const peer = details.peer;
            if (peer) {
                if (this._verbose >= 0) {
                    console.info(`${this._swarmName}: Connecting to peer: ${peer.host}:${peer.port}${peer.local ? " (local)" : ""}`);
                }
                // const pc = new PeerConnection(peer, jsonSocket);
                // this._peerConnections[peerId] = pc;
            }

            jsonSocket.sendMessage({type: 'initial', from: details.client ? 'server' : 'client', nodeId: this._nodeId, protocolVersion: PROTOCOL_VERSION});
            let receivedInitialMessage = false;
            jsonSocket.on('message', msg => {
                if (receivedInitialMessage) return;
                receivedInitialMessage = true;
                if (msg.type !== 'initial') {
                    console.warn('Unexpected initial message from peer connection. Closing.');
                    socket.destroy();
                    return;
                }
                if (msg.protocolVersion !== PROTOCOL_VERSION) {
                    console.warn('Incorrect protocol version from peer connection. Closing.');
                    socket.destroy();
                    return;
                }
                if (!validatePeerNodeId(msg.nodeId)) {
                    console.warn('Missing or incorrect node ID from peer connection. Closing.');
                    socket.destroy();
                    return;
                }
                if (msg.from !== (details.client ? 'client' : 'server')) {
                    console.warn('Unexpected "from" field from peer connection. Closing.');
                    socket.destroy();
                    return;
                }
                if (!this._peerConnections[msg.nodeId]) {
                    const peerConnection = new HPeerConnection({swarmName: this._swarmName, peerId: msg.nodeId, verbose: this._verbose});
                    this._peerConnections[msg.nodeId] = peerConnection;
                    peerConnection.onMessage((msg2, details) => {
                        this._handleMessageFromPeer(msg.nodeId, msg2);
                    });
                }
                if (details.client) {
                    this._peerConnections[msg.nodeId].setOutgoingSocket(jsonSocket);
                }
                else {
                    this._peerConnections[msg.nodeId].setIncomingSocket(jsonSocket);
                }
                if (details.peer) {
                    console.info(`${this._swarmName}: Connected to peer: ${peer.host}:${peer.port}${peer.local ? " (local)" : ""} (${msg.nodeId})`);
                    this._peerConnections[msg.nodeId].setConnectionInfo({host: details.peer.host, port: details.peer.port, local: details.peer.local});
                }
                socket.on('close', () => {
                    if (msg.nodeId in this._peerConnections) {
                        const peerInfo = this._peerConnections[msg.nodeId].connectionInfo();
                        console.info(`Socket closed for peer connection: ${peerInfo.host}:${peerInfo.port}${peerInfo.local ? " (local)" : ""} (${msg.nodeId})`);
                        this._peerConnections[msg.nodeId].disconnect();
                        delete this._peerConnections[msg.nodeId];
                        this.printInfo();
                    }
                })

                this.printInfo();
            });
        });
        this._hyperswarm.on('disconnection', (socket, info) => {
            const peer = info.peer;
            if (peer) {
                if (this._verbose >= 0) {
                    console.info(`${this._swarmName}: Disconnecting from peer: ${peer.host}:${peer.port}${peer.local ? " (local)" : ""}`);
                }
            }
        })
        this.printInfo();
    }
    async leave() {
        this._hyperswarm.leave(this._topic);
    }
    peerIds() {
        return Object.keys(this._peerConnections);
    }
    peerConnection(peerId) {
        return this._peerConnections[peerId];
    }
    numPeers() {
        return Object.keys(this._peerConnections).length;
    }
    disconnectPeer(peerId) {
        if (!(peerId in this._peerConnections)) {
            console.warn(`Cannot disconnect from peer. Not connected: ${peerId}`);
            return;
        }
        this._peerConnections[peerId].disconnect();
        delete this._peerConnections[peerId];
    }
    printInfo() {
        const numPeers = this.numPeers();
        console.info(`${numPeers} ${numPeers === 1 ? "peer" : "peers"}`);
    }
    broadcastMessage = (message, opts) => {
        const messageId = (opts || {}).messageId || randomString(10);
        this._messageIdsHandled[messageId] = true;
        const peerIds = Object.keys(this._peerConnections);
        peerIds.forEach(peerId => {
            this._peerConnections[peerId].sendMessage({
                type: 'broadcast',
                messageId,
                message
            });
        })
    }
    onMessage = cb => {
        this._onMessageCallbacks.push(cb);
    }
    createMessageListener = testFunction => {
        const x = {
            id: randomString(),
            testFunction,
            onMessageCallbacks: []
        };
        this._messageListeners[x.id] = x;
        return {
            onMessage: cb => {x.onMessageCallbacks.push(cb);},
            cancel: () => {
                delete this._messageListeners[x.id]
            }
        };
    }
    _handleMessageFromPeer = (peerId, msg) => {
        if (this._verbose >= 2) {
            console.info(`handleMessageFromPeer: ${this._swarmName} ${peerId} ${msg.type}`);
        }
        if (msg.type === 'broadcast') {
            const messageId = msg.messageId;
            if (messageId in this._messageIdsHandled) {
                return;
            }
            this._messageIdsHandled[messageId] = true;
            for (let cb of this._onMessageCallbacks) {
                cb(msg.message);
            }
            this.broadcastMessage(msg.message, {messageId: messageId});
        }
        else if (msg.type === 'keepAlive') {

        }
        else {
            // todo: disconnect from peer
            console.warn(`Unexpected message type: ${msg.type}`);
        }
    }

    async _start() {
        while (true) {
            const peerIds = this.peerIds();
            for (let peerId of peerIds) {
                const peerConnection = this._peerConnections[peerId];
                if (peerConnection.elapsedTimeSecSinceLastIncomingMessage() > 10) {
                    this.disconnectPeer(peerId);
                }
                if (peerConnection.elapsedTimeSecSinceLastOutgoingMessage() > 5) {
                    peerConnection.sendMessage({type: 'keepAlive'});
                }
            }

            await sleepMsec(100);
        }
    }
}

const validatePeerNodeId = (nodeId) => {
    return ((nodeId) && (typeof(nodeId) == 'string') && (nodeId.length <= 256));
}

export default HSwarmConnection;
import HyperswarmConnection from './HyperswarmConnection.js';
import { sleepMsec } from '../../common/util.js';
import { JSONStringifyDeterministic } from '../../common/crypto_util.js';

class PeerDiscoveryEngine {
    constructor({keyPair, swarmName, nodeId, nodeInfo, verbose, protocolVersion}) {
        this._keyPair = keyPair; // The keypair for signing messages -- the public key corresponds to the node ID
        this._swarmName = swarmName; // The swarm name (related to the channel)
        this._nodeId = nodeId; // The node ID (determined by the public key in the keypair)
        this._nodeInfo = nodeInfo; // The information to be reported to the other nodes in the swarm -- like the host and port (for listening for websockets)
        this._verbose = verbose; // Integer verbosity level. 0 means silent
        this._onPeerNodeInfoChangedCallbacks = []; // When a peer announces new information (nodeInfo) about itself
        this._halt = false; // Whether we have halted this engine via leave
        this._hyperswarmConnection = new HyperswarmConnection({keyPair, swarmName, nodeId, verbose, protocolVersion}); // Interface to hyperswarm
        this._peerNodeInfos = {}; // The infos received from the peer nodes (like host, port, local)

        // listen to incoming messages
        this._hyperswarmConnection.onMessage((fromNodeId, msg) => {
            this._handleHyperswarmConnectionMessage(fromNodeId, msg);
        });
        // join the hyperswarm
        this._hyperswarmConnection.join();

        // schedule for us to announce ourself to the swarm
        this._scheduleAnnounceSelfToSwarm = true;

        this._start();
    }
    // Get a callback when a peer node info has changed
    // cb({nodeId, nodeInfo})
    onPeerNodeInfoChanged(cb) {
        this._onPeerNodeInfoChangedCallbacks.push(cb);
    }
    // Leave this swarm
    leave() {
        this._halt = true;
    }

    // IMPLEMENTATION ////////////////////////////////////////////////////////////////////
    _handleHyperswarmConnectionMessage(fromNodeId, msg) {
        if (msg.type === 'announce') {
            // peer is announcing its node info
            if (msg.nodeId !== fromNodeId) {
                console.warn('DISCOVERY: Unexpected: msg.nodeId <> fromNodeId', msg.nodeId, fromNodeId);
                return;
            }
            // todo: other validation
            const nodeInfoOld = this._peerNodeInfos[fromNodeId] || {};
            const nodeInfoNew = msg.nodeInfo;
            nodeInfoNew.local = this._hyperswarmConnection.peerIsLocal(fromNodeId); 
            if (JSONStringifyDeterministic(nodeInfoNew) !== JSONStringifyDeterministic(nodeInfoOld)) {
                // something has changed
                this._peerNodeInfos[fromNodeId] = nodeInfoNew;
                this._onPeerNodeInfoChangedCallbacks.forEach(cb => {
                    cb({
                        peerId: fromNodeId,
                        peerNodeInfo: nodeInfoNew
                    });
                });
                // schedule announce ourself once again since something in the swarm has changed
                this._scheduleAnnounceSelfToSwarm = true;
            }
        }
    }
    _announceSelfToSwarm() {
        // announce our node info to the swarm
        this._hyperswarmConnection.broadcastMessage({
            type: 'announce',
            nodeId: this._nodeId,
            nodeInfo: this._nodeInfo
        })
    }
    async _start() {
        // Periodically announce self to swarm
        let timeLastAnnounce = new Date();
        const interval = 10000; // announce ourself periodically to the swarm, or whenever scheduled
        await sleepMsec(200);
        while (true) {
            if (this._halt) return;
            const elapsed = (new Date()) - timeLastAnnounce;
            if ((this._scheduleAnnounceSelfToSwarm) || (elapsed > interval)) {
                timeLastAnnounce = new Date();
                this._scheduleAnnounceSelfToSwarm = false;
                this._announceSelfToSwarm();    
            }
            await sleepMsec(1000);
        }
    }
}

export default PeerDiscoveryEngine;
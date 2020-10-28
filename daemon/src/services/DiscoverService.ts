import { action } from "../common/action";
import { sleepMsec } from "../common/util";
import { HttpPostJsonError } from "../external/real/httpRequests";
import { ChannelName, DurationMsec, durationMsecToNumber, elapsedSince, NodeId, nowTimestamp, scaledDurationMsec, Timestamp, zeroTimestamp } from "../interfaces/core";
import { GetChannelInfoRequestData, isGetChannelInfoResponseData } from "../interfaces/NodeToNodeRequest";
import KacheryP2PNode from "../KacheryP2PNode";
import RemoteNode from "../RemoteNode";
import RemoteNodeManager from "../RemoteNodeManager";

export default class DiscoverService {
    #node: KacheryP2PNode
    #remoteNodeManager: RemoteNodeManager
    #halted = false
    constructor(node: KacheryP2PNode, private opts: {discoverBootstrapIntervalMsec: DurationMsec, discoverRandomNodeIntervalMsec: DurationMsec}) {
        this.#node = node
        this.#remoteNodeManager = node.remoteNodeManager()

        this.#remoteNodeManager.onBootstrapNodeAdded((bootstrapNodeId) => {
            if (this.#halted) return
            const channelNames = this.#node.channelNames()
            for (let channelName of channelNames) {
                /////////////////////////////////////////////////////////////////////////
                action('discoverFromNewBootstrap', {context: 'DiscoverService', bootstrapNodeId, channelName}, async () => {
                    await this._getChannelInfoFromNode(bootstrapNodeId, channelName)
                }, null)
                /////////////////////////////////////////////////////////////////////////
            }
        })

        this._start();
    }
    stop() {
        this.#halted = true
    }
    async _getChannelInfoFromNode(remoteNodeId: NodeId, channelName: ChannelName) {
        let numPasses = 0
        while (!this.#remoteNodeManager.canSendRequestToNode(remoteNodeId, 'default')) {
            numPasses ++
            if (numPasses > 3) return
            await sleepMsec(scaledDurationMsec(1500))
        }
        const requestData: GetChannelInfoRequestData = {
            requestType: 'getChannelInfo',
            channelName
        }
        let responseData
        try {
            responseData = await this.#remoteNodeManager.sendRequestToNode(remoteNodeId, requestData, {timeoutMsec: scaledDurationMsec(4000), method: 'default'})
        }
        catch(err) {
            if (err instanceof HttpPostJsonError) {
                // the node is probably not connected
                return
            }
            else {
                throw err
            }
        }
        if (!isGetChannelInfoResponseData(responseData)) {
            throw Error('Unexpected.');
        }
        const { channelInfo } = responseData;
        channelInfo.nodes.forEach(channelNodeInfo => {
            if (channelNodeInfo.body.nodeId !== this.#node.nodeId()) {
                this.#remoteNodeManager.setChannelNodeInfo(channelNodeInfo)
            }
        })
    }
    async _start() {
        // Get channel info from other nodes in our channels
        let lastBootstrapDiscoverTimestamp: Timestamp = zeroTimestamp()
        let lastRandomNodeDiscoverTimestamp: Timestamp = zeroTimestamp()
        while (true) {
            if (this.#halted) return
            // periodically get channel info from bootstrap nodes
            const elapsedSinceLastBootstrapDiscover = elapsedSince(lastBootstrapDiscoverTimestamp);
            if (elapsedSinceLastBootstrapDiscover > durationMsecToNumber(this.opts.discoverBootstrapIntervalMsec)) {
                const bootstrapNodes: RemoteNode[] = this.#remoteNodeManager.getBootstrapRemoteNodes();
                const channelNames = this.#node.channelNames();
                for (let bootstrapNode of bootstrapNodes) {
                    for (let channelName of channelNames) {
                        /////////////////////////////////////////////////////////////////////////
                        await action('discoverFromBootstrapNode', {context: 'DiscoverService', bootstrapNodeId: bootstrapNode.remoteNodeId(), channelName}, async () => {
                            await this._getChannelInfoFromNode(bootstrapNode.remoteNodeId(), channelName);
                        }, null);
                        /////////////////////////////////////////////////////////////////////////
                    }
                }
                lastBootstrapDiscoverTimestamp = nowTimestamp();
            }
            
            const elapsedSinceLastRandomNodeDiscover = elapsedSince(lastRandomNodeDiscoverTimestamp)
            if (elapsedSinceLastRandomNodeDiscover > durationMsecToNumber(this.opts.discoverRandomNodeIntervalMsec)) {
                // for each channel, choose a random node and get the channel info from that node
                const channelNames = this.#node.channelNames();
                for (let channelName of channelNames) {
                    let nodes = this.#remoteNodeManager.getRemoteNodesInChannel(channelName);
                    if (nodes.length > 0) {
                        var randomNode = nodes[randomIndex(nodes.length)];
                        /////////////////////////////////////////////////////////////////////////
                        await action('discoverFromRandomNode', {context: 'DiscoverService', remoteNodeId: randomNode.remoteNodeId(), channelName}, async () => {
                            await this._getChannelInfoFromNode(randomNode.remoteNodeId(), channelName);
                        }, null);
                        /////////////////////////////////////////////////////////////////////////
                    }
                }
                lastRandomNodeDiscoverTimestamp = nowTimestamp()
            }

            await sleepMsec(scaledDurationMsec(500), () => {return !this.#halted})
        }
    }
}

const randomIndex = (n: number): number => {
    return Math.floor(Math.random() * n);
}
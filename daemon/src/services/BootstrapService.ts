import { action } from "../action";
import { sleepMsec } from "../common/util";
import { httpPostJson, urlPath } from "../httpPostJson";
import { Address } from "../interfaces/core";
import KacheryP2PNode from "../KacheryP2PNode";
import { isApiProbeResponse } from "../PublicApiServer";
import RemoteNodeManager from "../RemoteNodeManager";

export default class BootstrapService {
    #node: KacheryP2PNode
    #remoteNodeManager: RemoteNodeManager
    constructor(node: KacheryP2PNode) {
        this.#node = node
        this.#remoteNodeManager = node.remoteNodeManager()
        this._start();
    }
    async _probeBootstrapNode(address: Address) {
        const response = await httpPostJson(address, urlPath('/probe'), {}, {timeoutMsec: 2000});
        if (!isApiProbeResponse(response)) {
            throw Error('Invalid probe response from bootstrap node.');
        }
        const {nodeId: remoteNodeId, isBootstrapNode, webSocketAddress} = response
        if (!isBootstrapNode) {
            throw Error('isBootstrapNode is false in probe response from bootstrap node.')
        }
        this.#remoteNodeManager.setBootstrapNode(remoteNodeId, address, webSocketAddress)
    }
    async _start() {
        // probe the bootstrap nodes periodically
        while (true) {
            for (let address of this.#node.bootstrapAddresses()) {
                action('probeBootstrapNode', {context: 'BootstrapService', address}, async () => {
                    await this._probeBootstrapNode(address)
                }, null);
            }
            await sleepMsec(15000);
        }
    }
}
interface BtfBlock {
  id: string,
  header: object,
  producer_signatures: string[],
  previous_bmroot: string
  bmproofpath?: []
  block_num?: number
}

export interface Proof{
  blockproof:{
    chain_id: string,
    blocktoprove:{
      block: BtfBlock,
      active_nodes: string[],
      node_count: number  
    },
    bftproof: BtfBlock[],
  },
  actionproof: any
}

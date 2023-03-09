const SHIP = require('./ship');
const { getActionProof } = require("./ibcFunctions")
const axios = require('axios');
//Digest
const getShipIrreversibleBlock = async start_block_num =>{
  return new Promise(resolve=>{
    const ship = new SHIP(callback);

    ship.start(process.env.SHIP_WS, ()=>{
      ship.requestBlocks({ start_block_num, end_block_num: start_block_num+1, irreversible_only :true,  })
    });

    function callback(response){
      ship.disconnect();
      delete ship;
      resolve(response);
    } 
  });
}


const getShipHeavyProof = req => new Promise((resolve) => {
  let blocksReceived = [];
  //TODO check last lib from lightproof-db and if block to prove is over 500 blocks behind lib, get just irreversible blocks

  let threshold = 14; //TODO update based on # of bps in last schedule in ibc contract
  let ws = req.ws;
  let lastProgress = 0;
  let stopFlag = false;

  const merkleTrees = [];
  let reversibleBlocks = [];
  let uniqueProducers1 = [];
  let uniqueProducers2 = [];
  let block_to_prove;
  let previous_block;

  try{
    const ship = new SHIP(on_block);
    ship.start(process.env.SHIP_WS, ()=>{ ship.requestBlocks({ start_block_num: req.firehoseOptions.start_block_num }) });

    // pushRunningStream({stream, id: ws.id})

    //handler for on_block event
    async function on_block(json_obj){
      if (stopFlag) return;
      let add = true;

      //add progress (not essential as we wait for LIB now)
      try{
        let progress = Math.floor((json_obj.block_num - req.firehoseOptions.start_block_num)/330*100); //TODO update based on # of bps
        if (progress > lastProgress) {
          lastProgress = progress;
          ws.send(JSON.stringify({type:"progress", progress: Math.min(progress,100)}));
        }
      }catch(ex){ console.log("Couldn't send progress update to client")}

      //NEW BLOCK object
      console.log("received : ", json_obj.block_num);
     
      const block = {
        block_num: json_obj.block_num,
        number: json_obj.block_num,
        id : json_obj.id,
        header : json_obj.header,
        // merkle : blockrootMerkle,
        traces : json_obj.traces,

        transactions : json_obj.transactions,
        producer_signatures : [json_obj.producer_signature]
      }

      //format ship header
      let header = {};
   
      header.timestamp = block.header.timestamp;
      header.producer = block.header.producer;
      header.confirmed = block.header.confirmed;
      header.previous = block.header.previous.toLowerCase();
      header.transaction_mroot = block.header.transaction_mroot.toLowerCase();
      header.action_mroot = block.header.action_mroot.toLowerCase();
      header.schedule_version = block.header.schedule_version;
      header.new_producers = block.header.new_producers;
      header.header_extensions = block.header.header_extensions;

      block.header = header;

      //if block is signed by eosio
      if (block.header.producer == "eosio") {
        console.log("Found block signed by eosio. Proof is not supported");
        console.log("block : ", JSON.stringify(block, null, 2));
        stream.cancel();
        stopFlag = true;
        return ws.send(JSON.stringify({type:"error", error: "Found block signed by eosio. Proof is not supported"}));
      }


      if (blocksReceived.includes(json_obj.block_num))  {
        for (var i; i<10;i++) console.log("UNDO");
        console.log("received the same block again : ", json_obj.block_num);

        var prev_count = uniqueProducers1.length;

        reversibleBlocks = reversibleBlocks.filter(data => data.number != block.number);
        uniqueProducers1 = uniqueProducers1.filter(data => data.number != block.number);
        uniqueProducers2 = uniqueProducers2.filter(data => data.number != block.number);

        //rollback finality candidate
        if (prev_count == threshold && uniqueProducers1.length < threshold) uniqueProducers2 = [];
        blocksReceived = blocksReceived.filter(r=>r!=block.number);
      }
     

      blocksReceived.push(block.number);

      if (block.number > 500 + req.firehoseOptions.start_block_num ) {
        ship.disconnect();
        stopFlag = true;
        return ws.send(JSON.stringify({type:"error", error: "Not enough producers at this block height, stream cancelled"}));
      }
      //if first block in request
      if (block.number == req.firehoseOptions.start_block_num ){
        // previous_block = preprocessBlock(json_obj, false);
        previous_block = block;
        return add = false;
      }

      //if second block in request
      else if (block.number == req.firehoseOptions.start_block_num + 1){
        // block_to_prove = preprocessFirehoseBlock(json_obj, true);
        block_to_prove = block;
        add = false;
      }

      //if uniqueProducers1 threshold reached
      if (uniqueProducers1.length==threshold){

        let producer;

        if (uniqueProducers2.length>0) producer = uniqueProducers2.find(prod => prod.name == block.header.producer);
        else if (uniqueProducers1[uniqueProducers1.length-1].name == block.header.producer) producer = block.header.producer;

        if (!producer) uniqueProducers2.push({name: block.header.producer, number: block.number});

        //when enough blocks are collected
        if (uniqueProducers2.length==threshold) {
          console.log("Collected enough blocks");

          // stream.cancel();
          stopFlag = true;

          reversibleBlocks.push({ number: block.number, block });
          // last_bft_block = preprocessFirehoseBlock(JSON.parse(JSON.stringify(json_obj)));

          return on_proof_complete({reversibleBlocks, uniqueProducers1, uniqueProducers2});
        }
      }

      //if uniqueProducers1 threshold has not been reached
      else {
        if (uniqueProducers1.length>0){
          const producer = uniqueProducers1.find(prod => prod.name == block.header.producer);
          // console.log("producer",block.number,producer)
          if (!producer && block.header.producer != block_to_prove.header.producer) uniqueProducers1.push({name: block.header.producer, number: block.number});
        }
        else if (block.header.producer != block_to_prove.header.producer) uniqueProducers1.push({name: block.header.producer, number: block.number});
      }

      if (add) reversibleBlocks.push({number: block.number, block});
   
    }

    //handler for on_proof_complete event
    async function on_proof_complete(data){
      console.log("\non_proof_complete\n");
      ship.disconnect();
      delete ship;

      const blockToProveNodes = (await axios.get(`${process.env.LIGHTPROOF_API}?blocks=${block_to_prove.block_num}`)).data[0].nodes
      const previousBlockNodes = (await axios.get(`${process.env.LIGHTPROOF_API}?blocks=${previous_block.block_num}`)).data[0].nodes
     

      const proof = {
        blockproof:{
          chain_id: process.env.CHAIN_ID,
          blocktoprove:{
            block:{
              header: block_to_prove.header,
              producer_signatures: block_to_prove.producer_signatures,
              previous_bmroot: blockToProveNodes[blockToProveNodes.length-1],
              id: "",
              bmproofpath: []
            },
            active_nodes: previousBlockNodes,
            node_count: previous_block.block_num-1  
          },
          bftproof: []
        }
      }

      for (var row of data.reversibleBlocks){
        var up1 = data.uniqueProducers1.find(item => item.number == row.number);
        var up2 = data.uniqueProducers2.find(item => item.number == row.number);
        if (up1 || up2) proof.blockproof.bftproof.push( formatBFTBlock(row.number, row.block) );
      }

      if (req.action_receipt_digest) proof.actionproof = getActionProof(block_to_prove, req.action_receipt_digest);
      // for (var tree of merkleTrees) for (var node of tree.activeNodes) node = hex64.toHex(node);

      //format timestamp in headers
      // for (var bftproof of proof.blockproof.bftproof) bftproof.header.timestamp = convertFirehoseDate(bftproof.header.timestamp) ;
      // proof.blockproof.blocktoprove.block.header.timestamp = convertFirehoseDate(proof.blockproof.blocktoprove.block.header.timestamp);
      let blocksTofetch = [];
      for (var bftproof of proof.blockproof.bftproof )  {
        blocksTofetch.push(bftproof.block_num);
      };
      const uniqueList = [];
      for (var num of blocksTofetch) if (!uniqueList.includes(num)) uniqueList.push(num);
      let result = (await axios(`${process.env.LIGHTPROOF_API}?blocks=${uniqueList.join(',')}`)).data;
  
      for (var i = 0 ; i < blocksTofetch.length;i++) {
        const b = result.find(r=>r.num === blocksTofetch[i]);
        if(!b){
          console.log("Error, block not found!",  blocksTofetch[i]);
          process.exit();
        }
        proof.blockproof.bftproof[i].previous_bmroot = b.nodes[b.nodes.length-1];
      }

      resolve(proof);
    }
  }catch(ex){ console.log("getHeavyProof ex", ex) }
}); //end of getHeavyProof


const formatBFTBlock = (number, block) => ({
  id : block.id,
  block_num : number, 
  header : block.header,
  producer_signatures: block.producer_signatures,
})

module.exports = {
  getShipIrreversibleBlock,
  getShipHeavyProof
}
const { getActionProof, getBaseActionDigest, getDataDigest } = require("./ibcFunctions")
const crypto = require("crypto");
const axios = require('axios');
const sleep = s => new Promise(resolve=>setTimeout(resolve, s*1000));

const getNodeosIrreversibleBlock = block_num => fetchBlock(block_num);
const getNodeoseHeavyProof = (req, transactions) => new Promise(async (resolve) => {

  // console.log("getNodeoseHeavyProof", transactions)
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
  let currentBlock;

  try{

    let previousRes =  await fetchBlock(req.firehoseOptions.start_block_num);
    previous_block = formatBlockRes(previousRes);

    currentBlock = req.firehoseOptions.start_block_num + 1;

    while (stopFlag === false){
      try{
        let res = await fetchBlock(currentBlock);
        on_block(formatBlockRes(res))
      }catch(ex){
        console.log(ex.response)
        await sleep(2);
        let res = await fetchBlock(currentBlock);
        on_block(formatBlockRes(res))
      }

    }

    //handler for on_block event
    async function on_block(block){
      if (stopFlag) return;
      let add = true;

      //add progress (not essential as we wait for LIB now)
      try{
        let progress = Math.floor((block.block_num - req.firehoseOptions.start_block_num)/330*100); //TODO update based on # of bps
        if (progress > lastProgress) {
          lastProgress = progress;
          ws.send(JSON.stringify({type:"progress", progress: Math.min(progress,100)}));
        }
      }catch(ex){ console.log("Couldn't send progress update to client")}

      //NEW BLOCK object
      console.log("received : ", block.block_num);

      //if block is signed by eosio
      if (block.header.producer == "eosio") {
        console.log("Found block signed by eosio. Proof is not supported");
        console.log("block : ", JSON.stringify(block, null, 2));
        stopFlag = true;
        return ws.send(JSON.stringify({type:"error", error: "Found block signed by eosio. Proof is not supported"}));
      }
     

      blocksReceived.push(block.number);

      if (block.number > 500 + req.firehoseOptions.start_block_num ) {
        stopFlag = true;
        return ws.send(JSON.stringify({type:"error", error: "Not enough producers at this block height, stream cancelled"}));
      }
      //if first block in request
      // if (block.number == req.firehoseOptions.start_block_num ){
      //   // previous_block = preprocessBlock(json_obj, false);
      //   previous_block = block;
      //   return add = false;
      // }

      //if second block in request
      if (block.number == req.firehoseOptions.start_block_num + 1){
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
      currentBlock++;
    }

    //handler for on_proof_complete event
    async function on_proof_complete(data){
      console.log("\non_proof_complete\n");

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

      if (req.action_receipt_digest) {
        // console.log("here",req.action_receipt_digest)
        proof.actionproof = getActionProof({transactions, block_num: block_to_prove.block_num}, req.action_receipt_digest)
      }


      let blocksTofetch = [];
      for (var bftproof of proof.blockproof.bftproof ) blocksTofetch.push(bftproof.block_num);
      
      const uniqueList = [];
      for (var num of blocksTofetch) if (!uniqueList.includes(num)) uniqueList.push(num);
      let result = (await axios(`${process.env.LIGHTPROOF_API}?blocks=${uniqueList.join(',')}`)).data;
      // console.log("result",result)
  
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


const fetchBlock = block_num_or_id => axios.post(`${process.env.NODEOS_HTTP}/v1/chain/get_block`, JSON.stringify({block_num_or_id}));

const formatBlockRes = res =>{
  let header = {};
   
  header.timestamp = res.data.timestamp;
  header.producer = res.data.producer;
  header.confirmed = res.data.confirmed;
  header.previous = res.data.previous;
  header.transaction_mroot = res.data.transaction_mroot;
  header.action_mroot = res.data.action_mroot;
  header.schedule_version = res.data.schedule_version;
  header.new_producers = res.data.new_producers;
  header.header_extensions = res.data.header_extensions || [];

  return {
    block_num: res.data.block_num,
    number: res.data.block_num,
    id : res.data.id,
    header,
    producer_signatures : [res.data.producer_signature]
  }
}

const formatBFTBlock = (number, block) => ({
  id : block.id,
  block_num : number, 
  header : block.header,
  producer_signatures: block.producer_signatures,
})

async function convertNodeosAction(act, block_num){
  let auth_sequence = [];
  if(act.receipt.auth_sequence && act.receipt.auth_sequence.length)
    for (var authSequence of act.receipt.auth_sequence)  auth_sequence.push({ account: authSequence[0], sequence: authSequence[1] })


  const returnValueEnabled = block_num >= parseInt(process.env.RETURN_VALUE_ACTIVATION);

  //fix act_digest from greymass if return value is enabled for that block
  if (returnValueEnabled){
    var base_hash = await getBaseActionDigest(act.act);
    // console.log("base_hash",base_hash)
    var data_hash = await getDataDigest(act.act, "");

    var buff1 = Buffer.from(base_hash, "hex")
    var buff2 = Buffer.from(data_hash, "hex")

    var buffFinal = Buffer.concat([buff1, buff2]);
    act.receipt.act_digest = await crypto.createHash("sha256").update(buffFinal).digest("hex");
  }

  return {
    action: {
      account: act.act.account,
      name: act.act.name,
      authorization: act.act.authorization || [],
      data: act.act.data ? act.act.data : "",
      transactionId: act.trx_id
    },
    receipt:{
      abi_sequence: act.receipt.abi_sequence || 0,
      act_digest: act.receipt.act_digest || "",
      auth_sequence,
      code_sequence: act.receipt.code_sequence || 0,
      global_sequence: act.receipt.global_sequence || 0,
      receiver: act.receipt.receiver || "",
      recv_sequence: act.receipt.recv_sequence || 0,
    }
  }
}

module.exports = {
  getNodeosIrreversibleBlock,
  getNodeoseHeavyProof,
  convertNodeosAction,
  formatBlockRes
}
const hex64 = require('hex64');
const grpc = require("@grpc/grpc-js");
const axios = require("axios");
const { preprocessFirehoseBlock, getIrreversibleBlock, convertFirehoseDate, getFirehoseClient, checkValidBlockRange, formatBFTBlock, convertAction, pushRunningStream, eosioBlockMsg } = require("./firehoseFunctions")
const { getActionProof, getBmProof, verify, compressProof, getReceiptDigest } = require("./ibcFunctions")


const getHeavyProof = req => new Promise((resolve) => {
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
    const client = getFirehoseClient();
    let stream = client.Blocks(req.firehoseOptions)

    stream.on("data", (data) => {
      const { block: rawBlock } = data;
      const block = eosioBlockMsg.decode(rawBlock.value)
      on_block({block: JSON.parse(JSON.stringify(block, null, "  ")), step:data.step})
    });
    stream.on('error', (error) => {
      if (error.code === grpc.status.CANCELLED) return console.log("stream manually cancelled");
      console.log("error in streaming heavyblockproof", error);
      client.close();
    })
    stream.on('end', () => {
      console.log("end");
      client.close();
    });
    pushRunningStream({stream, id: ws.id})

    //handler for on_block event
    async function on_block(json_obj){
      if (stopFlag) return;
      let add = true;
      if (!json_obj.block) return;

      //add progress (not essential as we wait for LIB now)
      try{
        let progress = Math.floor((json_obj.block.number - req.firehoseOptions.start_block_num)/330*100); //TODO update based on # of bps
        if (progress > lastProgress) {
          lastProgress = progress;
          ws.send(JSON.stringify({type:"progress", progress: Math.min(progress,100)}));
        }
      }catch(ex){ console.log("Couldn't send progress update to client")}

      //NEW BLOCK object
      console.log("received : ", json_obj.block.number, " step : ", json_obj.step);

      const block = {
        id : json_obj.block.id,
        header : json_obj.block.header,
        merkle : json_obj.block.blockrootMerkle,
        traces : json_obj.block.unfilteredTransactionTraces,
        sig : [json_obj.block.producerSignature]
      }

      var mt = JSON.parse(JSON.stringify(json_obj.block.blockrootMerkle));
      mt.id = json_obj.block.id;
      merkleTrees.push(mt);

      //if block is signed by eosio
      if (json_obj.block.header.producer == "eosio") {
        console.log("Block signed by the eosio account found. Proving actions during bootstrapping not supported yet.\n");
        console.log("block : ", JSON.stringify(block, null, 2));
        stream.cancel();
        stopFlag = true;
        return ws.send(JSON.stringify({type:"error", error: "Block signed by the eosio account found. Proving actions during bootstrapping not supported yet"}));
      }

      //if block is new
      if (json_obj.step == "STEP_NEW"){

        if (json_obj.block.number > 500 + req.firehoseOptions.start_block_num ) {
          stream.cancel();
          stopFlag = true;
          return ws.send(JSON.stringify({type:"error", error: "Not enough producers at this block height, stream cancelled"}));
        }
        //if first block in request
        if (json_obj.block.number == req.firehoseOptions.start_block_num ){
          previous_block = preprocessFirehoseBlock(json_obj, false);
          return add = false;
        }

        //if second block in request
        else if (json_obj.block.number == req.firehoseOptions.start_block_num + 1){
          block_to_prove = preprocessFirehoseBlock(json_obj, true);
          add = false;
        }

        //if uniqueProducers1 threshold reached
        if (uniqueProducers1.length==threshold){

          let producer;

          if (uniqueProducers2.length>0) producer = uniqueProducers2.find(prod => prod.name == block.header.producer);
          else if (uniqueProducers1[uniqueProducers1.length-1].name == block.header.producer) producer = block.header.producer;

          if (!producer) uniqueProducers2.push({name: block.header.producer, number: json_obj.block.number});

          //when enough blocks are collected
          if (uniqueProducers2.length==threshold) {
            console.log("Collected enough blocks");

            stream.cancel();
            stopFlag = true;

            reversibleBlocks.push({ number: json_obj.block.number, block });
            last_bft_block = preprocessFirehoseBlock(JSON.parse(JSON.stringify(json_obj)));

            on_proof_complete({reversibleBlocks, uniqueProducers1, uniqueProducers2});
          }
        }

        //if uniqueProducers1 threshold has not been reached
        else {
          if (uniqueProducers1.length>0){
            const producer = uniqueProducers1.find(prod => prod.name == block.header.producer);
            if (!producer && block.header.producer != block_to_prove.header.producer) uniqueProducers1.push({name: block.header.producer, number: json_obj.block.number});
          }
          else if (block.header.producer != block_to_prove.header.producer) uniqueProducers1.push({name: block.header.producer, number: json_obj.block.number});
        }
        if (add) reversibleBlocks.push({number: json_obj.block.number, block});
      }

      //if block has been reversed
      else if (json_obj.step == "STEP_UNDO"){
        for (var i; i<10;i++) console.log("UNDO");

        var prev_count = uniqueProducers1.length;

        reversibleBlocks = reversibleBlocks.filter(data => data.number != json_obj.block.number);
        uniqueProducers1 = uniqueProducers1.filter(data => data.number != json_obj.block.number);
        uniqueProducers2 = uniqueProducers2.filter(data => data.number != json_obj.block.number);

        var after_count = uniqueProducers1.length;
        //rollback finality candidate
        if (prev_count == threshold && after_count < threshold) uniqueProducers2 = [];
      }
    }

    //handler for on_proof_complete event
    function on_proof_complete(data){
      for (var i; i<7;i++)  console.log("on_proof_complete");
      const proof = {
        blockproof:{
          chain_id: process.env.CHAIN_ID,
          blocktoprove:{
            block:{
              header: block_to_prove.header,
              producer_signatures: block_to_prove.producer_signatures,
              previous_bmroot: block_to_prove.merkle_tree.active_nodes[block_to_prove.merkle_tree.active_nodes.length-1],
              id: "",
              bmproofpath: []
            },
            active_nodes: previous_block.merkle_tree.active_nodes,
            node_count: previous_block.merkle_tree.node_count
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
      for (var tree of merkleTrees) for (var node of tree.activeNodes) node = hex64.toHex(node);

      //format timestamp in headers
      for (var bftproof of proof.blockproof.bftproof) bftproof.header.timestamp = convertFirehoseDate(bftproof.header.timestamp) ;
      proof.blockproof.blocktoprove.block.header.timestamp = convertFirehoseDate(proof.blockproof.blocktoprove.block.header.timestamp);

      resolve(proof);
    }
  }catch(ex){ console.log("getHeavyProof ex", ex) }
}); //end of getHeavyProof

//Websocket handlers
async function handleHeavyProof(msgObj, ws){
  try {
    const start_block_num  = msgObj.block_to_prove -1; //start at previous block of block that a user wants to prove

    let checkBlock = await checkValidBlockRange(start_block_num);
    if(!checkBlock.available) return ws.send(JSON.stringify({ type:"error", error: checkBlock.error }));

    const req_block_to_prove = {
      firehoseOptions : { start_block_num, include_filter_expr: "", fork_steps: ["STEP_NEW", "STEP_UNDO"] },
      action_receipt_digest: msgObj.action_receipt ? getReceiptDigest(msgObj.action_receipt) : msgObj.action_receipt_digest,
      ws
    }

    const response = {
      type: "proof",
      query : msgObj,
      proof: await getHeavyProof(req_block_to_prove),
      action_receipt_digest: req_block_to_prove.action_receipt_digest //required for issue & retire
    }

    //add bmproofpath to bftproofs
    let bmproofPromises = [];
    let btp = msgObj.block_to_prove;

    for (var bftproof of response.proof.blockproof.bftproof )  {
      bmproofPromises.push( getBmProof(btp, bftproof.block_num) );
      btp = bftproof.block_num;
    };

    let bmproofpaths = await Promise.all(bmproofPromises);

    //get block_to_prove block ID
    let blockID = (await axios.get(`${process.env.LIGHTPROOF_API}?blocks=${msgObj.block_to_prove}`)).data[0].id;
    //add bmproofpath to each bftproof
    response.proof.blockproof.bftproof.forEach((bftproof, i) => {
      bftproof.bmproofpath = bmproofpaths[i];
      var verif = verify(bftproof.bmproofpath, blockID, bftproof.previous_bmroot );

      console.log("\nbftproof:",i+1);
      console.log("block_to_prove:",msgObj.block_to_prove);
      console.log("last_proven_block:",bftproof.block_num);
      console.log("verif",verif);
      if (!verif){
        console.log("Verif failed for:");
        console.log("bftproof.bmproofpath (nodes)",bftproof.bmproofpath);
        console.log("blockID (leaf)",blockID);
        console.log("bftproof.previous_bmroot (root)",bftproof.previous_bmroot);
      }

      blockID = bftproof.id;
      delete bftproof.block_num;
      delete bftproof.id;
    });
    console.log("\nbftproof verification finished")
    response.proof = (compressProof({ proof: response.proof })).proof;
    ws.send(JSON.stringify(response));

  }catch(ex){
    console.log(ex);
    ws.send(JSON.stringify({type:"error", error: ex}));
  }
}

function handleLightProof(msgObj, ws){
  return new Promise(async resolve => {
    console.log(msgObj);

    let checkBlock = await checkValidBlockRange(msgObj.block_to_prove);
    if(!checkBlock.available) return ws.send(JSON.stringify({ type:"error", error: checkBlock.error }));
    let checkBlock2 = await checkValidBlockRange(msgObj.last_proven_block);
    if(!checkBlock2.available) return ws.send(JSON.stringify({ type:"error", error: checkBlock2.error }));

    var result = await Promise.all([ getIrreversibleBlock(msgObj.last_proven_block), getIrreversibleBlock(msgObj.block_to_prove) ]);

    var last_proven_block = preprocessFirehoseBlock(result[0]);
    var block_to_prove = preprocessFirehoseBlock(result[1]);

    var proof = {
      blockproof : {
        chain_id : process.env.CHAIN_ID,
        header : block_to_prove.header,
        root: last_proven_block.merkle_tree.active_nodes[last_proven_block.merkle_tree.active_nodes.length-1],
        bmproofpath : await getBmProof(msgObj.block_to_prove, msgObj.last_proven_block)
      }
    }

    if (msgObj.action_receipt || msgObj.action_receipt_digest){
      if (msgObj.action_receipt) msgObj.action_receipt_digest = getReceiptDigest(msgObj.action_receipt);
      proof.actionproof = getActionProof(block_to_prove, msgObj.action_receipt_digest)
    }

    proof.blockproof.header.timestamp = convertFirehoseDate(proof.blockproof.header.timestamp);
    ws.send(JSON.stringify({ type: "proof", query: msgObj, proof }));
    resolve();
  })
}

async function handleGetBlockActions(msgObj, ws){
  try {
    console.log("handleGetBlockActions", msgObj.block_to_prove);
    let checkBlock = await checkValidBlockRange(msgObj.block_to_prove);
    if(!checkBlock.available) return ws.send(JSON.stringify({ type:"error", error: checkBlock.error }));

    const txs = (await getIrreversibleBlock(msgObj.block_to_prove)).block.unfilteredTransactionTraces.map(r=> r.actionTraces );

    //Add action receipt digest and convert action rawData to hex
    for (var tx of txs)
      for (var act of tx){
        let action_receipt_digest = getReceiptDigest(act.receipt);
        const converted = convertAction(act);
        act.action = converted.action;
        act.receipt = converted.receipt;
        act.action_receipt_digest = action_receipt_digest;
      }

    ws.send(JSON.stringify({ type: "getBlockActions", query : msgObj, txs }));

  }catch(ex){
    console.log(ex);
    ws.send(JSON.stringify({type:"error", error: ex}));
  }
}

module.exports = {
  handleLightProof,
  handleHeavyProof,
  handleGetBlockActions,
}

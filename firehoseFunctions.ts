const grpcAddress = process.env.GRPC_ADDRESS;
const protoLoader = require("@grpc/proto-loader");
const grpc = require("@grpc/grpc-js");
const path = require("path");
const ProtoBuf = require("protobufjs");
const eosioProto = ProtoBuf.loadSync( path.resolve(__dirname, "proto",  "dfuse/eosio/codec/v1/codec.proto"));
const bstreamService = loadGrpcPackageDefinition("dfuse/bstream/v1/bstream.proto").dfuse.bstream.v1
const eosioBlockMsg = eosioProto.root.lookupType("dfuse.eosio.codec.v1.Block");

import hex64 from "hex64";
import { Proof } from "./types";
import  { getActionProof } from "./ibcFunctions";
// const { getActionProof } = require("./ibcFunctions")
function sleep (s:number){ return new Promise(resolve=>setTimeout(resolve, s*1000))};

const getFirehoseClient = () => new bstreamService.BlockStreamV2(
  grpcAddress,
  process.env.GRPC_INSECURE=='true' ? grpc.credentials.createInsecure(): grpc.credentials.createSsl(), {
    "grpc.max_receive_message_length": 1024 * 1024 * 100,
    "grpc.max_send_message_length": 1024 * 1024 * 100,
    "grpc.enable_retries": true
  }
);


const runningStreams = [];
function pushRunningStream (obj){ runningStreams.push(obj)}

const getFirehoseBlock = (req) => new Promise((resolve,reject) => {
  if (!req.retries && req.retires!==0) req.retries = 10;
  const client = getFirehoseClient();
  let stream = client.Blocks(req.firehoseOptions)

  stream.on("data", (data) => {
    const { block: rawBlock } = data;
    const block = eosioBlockMsg.decode(rawBlock.value)
    client.close();
    resolve({block: JSON.parse(JSON.stringify(block, null, "  ")), step:data.step})
  });
  stream.on('error', async error => {
    client.close();
    if (error.code === grpc.status.CANCELLED) console.log("stream manually cancelled");
    else {
      if(req.retries){
        console.log("req.retries",req.retries)
        await sleep((11-req.retries)*0.1);
        req.retries--;
        resolve(await getFirehoseBlock(req)) ;
      }
      else {
        console.log("Error in get block", error);
        console.log({...req, ws: null})
        if (req.ws) req.ws.send(JSON.stringify({ type:"error", error: "Could not stream block from firehose" }));
      }
    }
  })

});

const getFirehoseIrreversibleBlock = start_block_num => getFirehoseBlock({
  firehoseOptions : {
    start_block_num, stop_block_num: start_block_num,
    include_filter_expr: "",
    fork_steps: ["STEP_IRREVERSIBLE"]
  } 
})

function convertFirehoseDate(timestamp){
  //handle new ibc-prod server
  if (timestamp.seconds){
    let date = (new Date(parseInt(timestamp.seconds)*1000)).toISOString().replace('Z', '');
    if (timestamp.nanos) date = date.replace('000', '500')
    return date;
  }
  //old ibc server
  else return timestamp.slice(0,-1);
}

function convertFirehoseAction(act){
  let auth_sequence = [];
  if(act.receipt.authSequence && act.receipt.authSequence.length)
    for (var authSequence of act.receipt.authSequence)  auth_sequence.push({ account: authSequence.accountName, sequence: authSequence.sequence })

  return {
    action: {
      account: act.action.account,
      name: act.action.name,
      authorization: act.action.authorization || [],
      data: act.action.rawData ? hex64.toHex(act.action.rawData) : "",
    },
    receipt:{
      abi_sequence: act.receipt.abiSequence || 0,
      act_digest: act.receipt.digest || "",
      auth_sequence,
      code_sequence: act.receipt.codeSequence || 0,
      global_sequence: act.receipt.globalSequence || 0,
      receiver: act.receipt.receiver || "",
      recv_sequence: act.receipt.recvSequence || 0,
    }
  }
}

function preprocessFirehoseBlock(obj, keepTraces){

  var resp_obj = {
    id : obj.block.id,
    merkle_tree : obj.block.blockrootMerkle,
    header : obj.block.header,
    block_num :obj.block.number,
    producer_signatures : [obj.block.producerSignature],
    unfilteredTransactionTraces: null
  }

  if (keepTraces) resp_obj.unfilteredTransactionTraces = obj.block.unfilteredTransactionTraces;

  var hexNodes = [];

  resp_obj.merkle_tree.activeNodes.forEach(element =>  hexNodes.push(hex64.toHex(element)))

  resp_obj.merkle_tree.active_nodes = hexNodes;
  resp_obj.merkle_tree.node_count = resp_obj.merkle_tree.nodeCount;

  //resp_obj.header.previous = hex64.toHex(resp_obj.header.previous);

  resp_obj.header.transaction_mroot = hex64.toHex(resp_obj.header.transactionMroot);
  resp_obj.header.action_mroot = hex64.toHex(resp_obj.header.actionMroot);

  resp_obj.header.confirmed = resp_obj.header.confirmed ? resp_obj.header.confirmed : 0;
  resp_obj.header.schedule_version = resp_obj.header.scheduleVersion;

  //handle eosio 1.x
  if (resp_obj.header.newProducersV1){
    let producers = [];

    for (var pr of resp_obj.header.newProducersV1.producers)
      producers.push({ producer_name: pr.accountName, block_signing_key: pr.blockSigningKey})

    resp_obj.header.new_producers = {
      version: resp_obj.header.newProducersV1.version,
      producers
    }
  }
  else resp_obj.header.new_producers = resp_obj.header.newProducers ? resp_obj.header.newProducers : null;

//resp_obj.header.header_extensions = resp_obj.header.headerExtensions ? resp_obj.header.headerExtensions : [];
  if (resp_obj.header.headerExtensions){
    const extensions = [];

    for (var extension of resp_obj.header.headerExtensions){
      const first = extension.type || 0;
      const second = hex64.toHex(extension.data);
      extensions.push({first, second});
    }

    resp_obj.header.header_extensions = extensions;
  }
  else resp_obj.header.header_extensions = [];

  delete resp_obj.merkle_tree.activeNodes;
  delete resp_obj.merkle_tree.nodeCount;
  delete resp_obj.header.transactionMroot;
  delete resp_obj.header.actionMroot;
  delete resp_obj.header.scheduleVersion;
  delete resp_obj.header.newProducers;
  if (resp_obj.header.newProducersV1) delete resp_obj.header.newProducersV1; //if eosio 1.x
  delete resp_obj.header.headerExtensions;

  resp_obj.header.timestamp = convertFirehoseDate(resp_obj.header.timestamp);

  return resp_obj;
}

const closeClientStreams = id => {
  let streams = runningStreams.filter(r=>r.id===id);
  streams.forEach((element,index) => {
    if (element.stream) element.stream.cancel()
    runningStreams.splice(index, 1)
  })
  console.log("Running streams", runningStreams.length)
}

function loadGrpcPackageDefinition(p) {
  const proto = protoLoader.loadSync(
    path.resolve(__dirname, "proto", p),
    { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }
  )
  return grpc.loadPackageDefinition(proto)
}

//formatting
function formatBFTBlock(number, block){

  //handle eosio 1.x
  if (block.header.newProducersV1){
    let producers = [];

    for (var pr of block.header.newProducersV1.producers)
      producers.push({ producer_name: pr.accountName, block_signing_key: pr.blockSigningKey})

    block.header.new_producers = {
      version: block.header.newProducersV1.version,
      producers
    }
  }
  else block.header.new_producers = block.header.newProducers;

  block.header.header_extensions = block.header.headerExtensions;
  block.header.schedule_version = block.header.scheduleVersion;
  block.header.transaction_mroot = hex64.toHex( block.header.transactionMroot);
  block.header.action_mroot = hex64.toHex(block.header.actionMroot);

  delete block.header.transactionMroot;
  delete block.header.actionMroot;
  delete block.header.scheduleVersion;
  delete block.header.newProducers;
  if (block.header.newProducersV1) delete block.header.newProducersV1;
  delete block.header.headerExtensions;


  if (!block.header.confirmed) block.header.confirmed = 0;
  if (!block.header.new_producers) block.header.new_producers = null;
  if (!block.header.headerExtensions) block.header.header_extensions = [];

  block.header.timestamp = convertFirehoseDate(block.header.timestamp) ;

  //TODO : check a block with headerExtensions to see if base64 to hex translation is required

  // console.log("block ", block);

  var n_block = {
    id : block.id,
    block_num : number, //added for lightproof testing
    //producer : block.header.producer,
    header : block.header,
    //header_digest : getHeaderDigest(block.header),
    producer_signatures: block.sig,
    previous_bmroot: hex64.toHex(block.merkle.activeNodes[block.merkle.activeNodes.length-1])
  }

  return n_block;
}

const getFirehoseHeavyProof = (req): Promise<Proof> => new Promise((resolve) => {
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
    stream.on('end', () => { client.close(); });
    pushRunningStream({stream, id: ws.id})

    //handler for on_block event
    const on_block = function (json_obj){
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
        console.log("Found block signed by eosio. Proof is not supported");
        console.log("block : ", JSON.stringify(block, null, 2));
        stream.cancel();
        stopFlag = true;
        return ws.send(JSON.stringify({type:"error", error: "Found block signed by eosio. Proof is not supported"}));
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
            // last_bft_block = preprocessFirehoseBlock(JSON.parse(JSON.stringify(json_obj)));

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

        //rollback finality candidate
        if (prev_count == threshold && uniqueProducers1.length < threshold) uniqueProducers2 = [];
      }
    }

    //handler for on_proof_complete event
    const on_proof_complete = function(data){
      console.log("\non_proof_complete\n");
     

      let bftproofs = [];
      for (var row of data.reversibleBlocks){
        var up1 = data.uniqueProducers1.find(item => item.number == row.number);
        var up2 = data.uniqueProducers2.find(item => item.number == row.number);
        if (up1 || up2) bftproofs.push( formatBFTBlock(row.number, row.block) );
      }

      const proof: Proof = {
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
          bftproof: bftproofs,
        },
        actionproof: null
      }

      if (req.action_receipt_digest) proof.actionproof = getActionProof(block_to_prove, req.action_receipt_digest);
      else delete proof.actionproof;

      for (var tree of merkleTrees) for (var node of tree.activeNodes) node = hex64.toHex(node);

      //format timestamp in headers
      // for (var bftproof of proof.blockproof.bftproof) bftproof.header.timestamp = convertFirehoseDate(bftproof.header.timestamp) ;
      // proof.blockproof.blocktoprove.block.header.timestamp = convertFirehoseDate(proof.blockproof.blocktoprove.block.header.timestamp);
      resolve(proof);
    }
  }catch(ex){ console.log("getHeavyProof ex", ex) }
}); //end of getHeavyProof



export {
  getFirehoseClient,
  convertFirehoseDate,
  closeClientStreams,
  formatBFTBlock,
  preprocessFirehoseBlock,
  eosioBlockMsg,
  getFirehoseBlock,
  convertFirehoseAction,
  pushRunningStream,
  getFirehoseIrreversibleBlock,
  getFirehoseHeavyProof
}

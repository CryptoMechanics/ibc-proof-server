const runningStreams = [];
const firehoseMinBlock = parseInt(process.env.FIREHOSE_MIN_BLOCK);
const grpcAddress = process.env.GRPC_ADDRESS;
const protoLoader = require("@grpc/proto-loader");
const hex64 = require('hex64');
const grpc = require("@grpc/grpc-js");
const path = require("path");
const ProtoBuf = require("protobufjs");
const loadProto = package =>  ProtoBuf.loadSync( path.resolve(__dirname, "proto", package));
const axios = require("axios");

console.log("nodeosApi", process.env.NODEOS_API);
console.log("grpcAddress",grpcAddress);

const eosioProto = loadProto("dfuse/eosio/codec/v1/codec.proto")
const bstreamService = loadGrpcPackageDefinition("dfuse/bstream/v1/bstream.proto").dfuse.bstream.v1
const eosioBlockMsg = eosioProto.root.lookupType("dfuse.eosio.codec.v1.Block")



const sleep = s => new Promise(resolve=>setTimeout(resolve, s*1000));

const getFirehoseClient = () => new bstreamService.BlockStreamV2(
  grpcAddress,
  process.env.GRPC_INSECURE=='true' ? grpc.credentials.createInsecure(): grpc.credentials.createSsl(), {
    "grpc.max_receive_message_length": 1024 * 1024 * 100,
    "grpc.max_send_message_length": 1024 * 1024 * 100,
    "grpc.enable_retries": true
  }
);

const pushRunningStream = obj => runningStreams.push();
//fetching from firehose
const getBlock = req => new Promise((resolve,reject) => {
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
        resolve(await getBlock(req)) ;
      }
      else {
        console.log("Error in get block", error);
        console.log({...req, ws: null})
        if (req.ws) req.ws.send(JSON.stringify({ type:"error", error: "Could not stream block from firehose" }));
      }
    }
  })

});

const getIrreversibleBlock = block_num => getBlock({
  firehoseOptions : {
    start_block_num: block_num,
    stop_block_num: block_num,
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

function convertAction(act){
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


function checkValidBlockRange(blockNum){
  return new Promise(async resolve=>{
    try{
      blockNum = parseInt(blockNum);
      const headBlock = (await axios(`${process.env.NODEOS_API}/v1/chain/get_info`)).data.head_block_num;
      if (blockNum < firehoseMinBlock || blockNum > headBlock+350){
        resolve({
          available: false,
          error:  `Attempting to prove a block that is outside available range in firehose (${firehoseMinBlock} -> ${headBlock} )`
        });
      } else resolve({ available: true })
    }catch(ex){
      resolve({
        available: false,
        error:  `Error fetching headinfo from mindreader while checking block #${blockNum}`
      });
    }
  })
}

// async function handleGetBlockRange(msgObj, ws){
//   const response = { type: "blockRange", query : msgObj }
//   try{
//     const headBlock = (await axios(`${ process.env.NODEOS_API}/v1/chain/get_info`)).data.head_block_num;
//     response.start = firehoseMinBlock,
//     response.stop = headBlock
//   }catch(ex){ response.error = "Can't fetch head block from mindreader" };
//   ws.send(JSON.stringify(response));
// }

function preprocessFirehoseBlock(obj, keepTraces){

  var resp_obj = {
    id : obj.block.id,
    merkle_tree : obj.block.blockrootMerkle,
    header : obj.block.header,
    block_num :obj.block.number,
    producer_signatures : [obj.block.producerSignature]
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


function loadGrpcPackageDefinition(package) {
  const proto = protoLoader.loadSync(
    path.resolve(__dirname, "proto", package),
    { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }
  )
  return grpc.loadPackageDefinition(proto)
}


//formatting
function formatBFTHeader(header){

  if (!header.confirmed) header.confirmed = 0;
  if (!header.new_producers) header.new_producers = null;
  if (!header.headerExtensions) header.header_extensions = [];

  return header;
}

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

  //TODO : check a block with headerExtensions to see if base64 to hex translation is required

  // console.log("block ", block);

  var n_block = {
    id : block.id,
    block_num : number, //added for lightproof testing
    //producer : block.header.producer,
    header : formatBFTHeader(block.header),
    //header_digest : getHeaderDigest(block.header),
    producer_signatures: block.sig,
    previous_bmroot: hex64.toHex(block.merkle.activeNodes[block.merkle.activeNodes.length-1])
  }

  return n_block;
}


module.exports = {
  getFirehoseClient,
  convertFirehoseDate,
  checkValidBlockRange,
  getIrreversibleBlock,
  closeClientStreams,
  formatBFTBlock,
  preprocessFirehoseBlock,
  eosioBlockMsg,
  convertAction,
  pushRunningStream
  // handleGetBlockRange
}
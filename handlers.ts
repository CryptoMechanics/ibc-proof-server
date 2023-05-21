const axios = require("axios");
import { getIrreversibleBlock, preprocessBlock, getHeavyProof, getTxs } from "./abstract";
import { getActionProof, getBmProof, verify, compressProof, getReceiptDigest } from "./ibcFunctions";
const historyProvider = process.env.HISTORY_PROVIDER;

//Websocket handlers
async function handleHeavyProof(msgObj, ws){
  try {
    const start_block_num  = msgObj.block_to_prove - 1; //start at previous block of block that a user wants to prove

    let checkBlock = await checkValidBlockRange(start_block_num);
    if(!checkBlock.available) return ws.send(JSON.stringify({ type:"error", error: checkBlock.error }));

    const req_block_to_prove = {
      firehoseOptions : { start_block_num, include_filter_expr: "", fork_steps: ["STEP_NEW", "STEP_UNDO"] },
      action_receipt_digest: msgObj.action_receipt ? getReceiptDigest(msgObj.action_receipt) : msgObj.action_receipt_digest,
      ws,
      block_num:start_block_num
    }

    const response = {
      type: "proof",
      query : msgObj,
      proof : await getHeavyProof(req_block_to_prove),
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
    let passed = true;
    //add bmproofpath to each bftproof
    response.proof.blockproof.bftproof.forEach((bftproof, i) => {
      bftproof.bmproofpath = bmproofpaths[i];
      var verif = verify(bftproof.bmproofpath, blockID, bftproof.previous_bmroot );

      console.log("verif",i,verif);
      if (!verif){
        passed = false;
        console.log("\nbftproof:",i+1);
        console.log("block_to_prove:",msgObj.block_to_prove);
        console.log("last_proven_block:",bftproof.block_num);
        console.log("Verif failed for:");
        console.log("bftproof.bmproofpath (nodes)",bftproof.bmproofpath);
        console.log("blockID (leaf)",blockID);
        console.log("bftproof.previous_bmroot (root)",bftproof.previous_bmroot);
      }

      blockID = bftproof.id;
      delete bftproof.block_num;
      delete bftproof.id;
    });
    console.log("\nbftproof verification finished", passed)

    if (passed){
      response.proof = (compressProof({ proof: response.proof })).proof;
      ws.send(JSON.stringify(response));
    }
    else ws.send(JSON.stringify({type:"error", error: "bftproof verification failed, contact proof socket admin", query:response.query}));

  }catch(ex){
    console.log(ex);
    ws.send(JSON.stringify({type:"error", error: ex}));
  }
}

function handleLightProof(msgObj, ws){

  //just need the block to prove from the history provider

  return new Promise(async resolve => {
    console.log(msgObj);

    let checkBlock = await checkValidBlockRange(msgObj.block_to_prove);
    let checkBlock2 = await checkValidBlockRange(msgObj.last_proven_block);

    if (!checkBlock.available){
      console.log("Block is not in valid range")
      if(!checkBlock.available) return ws.send(JSON.stringify({ type:"error", error: checkBlock.error }));
      if(!checkBlock2.available) return ws.send(JSON.stringify({ type:"error", error: checkBlock2.error }));
    }

    var result = await getIrreversibleBlock(msgObj.block_to_prove);
    var block_to_prove = preprocessBlock(result, true);

    var proof = {
      blockproof : {
        chain_id : process.env.CHAIN_ID,
        header : block_to_prove.header,
        bmproofpath : await getBmProof(msgObj.block_to_prove, msgObj.last_proven_block)
      },
      actionproof: null
    }

    if (msgObj.action_receipt || msgObj.action_receipt_digest){
      if (msgObj.action_receipt) msgObj.action_receipt_digest = getReceiptDigest(msgObj.action_receipt);
      if (historyProvider==='greymass') {
        const transactions = await getTxs(block_to_prove);
        proof.actionproof = getActionProof({transactions, block_num: block_to_prove.block_num}, msgObj.action_receipt_digest)
      }
      else proof.actionproof = getActionProof(block_to_prove, msgObj.action_receipt_digest)
    }
    else delete proof.actionproof;
    
    let blockID = (await axios.get(`${process.env.LIGHTPROOF_API}?blocks=${msgObj.block_to_prove}`)).data[0].id;
    let lastProvenBlockNodes = (await axios.get(`${process.env.LIGHTPROOF_API}?blocks=${msgObj.last_proven_block}`)).data[0].nodes;
    //add bmproofpath to each bftproof
    var passed = verify(proof.blockproof.bmproofpath, blockID, lastProvenBlockNodes[lastProvenBlockNodes.length-1] );
    console.log("passed",passed);

    if (passed){
      console.log("Verified proof sent to client")
      ws.send(JSON.stringify({ type: "proof", query: msgObj, proof }));
    }
    else{
      // console.log("blockFromLP",blockFromLP)
      console.log("proof.blockproof.bmproofpath",proof.blockproof.bmproofpath);
      ws.send(JSON.stringify({type:"error", error: "bftproof verification failed, contact proof socket admin", query: JSON.stringify(msgObj)}));
    }
   
    resolve(null);
  })
}

async function handleGetBlockActions(msgObj, ws){
  try {
    console.log("handleGetBlockActions", msgObj.block_to_prove);
    // let checkBlock = await checkValidBlockRange(msgObj.block_to_prove);
    // if(!checkBlock.available) return ws.send(JSON.stringify({ type:"error", error: checkBlock.error }));

    let res = await getIrreversibleBlock(msgObj.block_to_prove);
    if(res.data) res = res.data;
    const txs = await getTxs(res);

    console.log("handleGetBlockActions finished", msgObj.block_to_prove)
    ws.send(JSON.stringify({ type: "getBlockActions", query : msgObj, txs }));

  }catch(ex){
    console.log(ex);
    ws.send(JSON.stringify({type:"error", error: ex}));
  }
}

async function handleGetDbStatus(ws){
  axios(`${process.env.LIGHTPROOF_API}/status`).then(res=>{
    ws.send(JSON.stringify({ type: "getDbStatus", data:res.data}));
  }).catch(ex=>{
    console.log("ex getting db status", ex.response.status, ex.response.statusText)
    ws.send(JSON.stringify({ type: "getDbStatus", data:{error:"Error getting DB status, contact admin"}}));
  });
}


async function checkValidBlockRange(blockNum){
  // interface ValidRange {
    // available: boolean;
    // error: any;
  // }
  // return new Promise(async resolve=>{
  try{
    blockNum = parseInt(blockNum);
    let { minBlockToProve,lastBlock, firstBlock } = (await axios(`${process.env.LIGHTPROOF_API}/status`)).data;
    if(!minBlockToProve) minBlockToProve = firstBlock;

    if (blockNum < minBlockToProve || blockNum > lastBlock)
      return({ available: false, error:  `Attempting to prove a block (#${blockNum}) that is outside proveable range in lightproof-db (${minBlockToProve} -> ${lastBlock} )` });
    else return({ available: true, error:false })
  }catch(ex){
    return({
      available: false,
      error:  `Error fetching status of lightproof`
    });
  }

}

export {
  handleLightProof,
  handleHeavyProof,
  handleGetBlockActions,
  handleGetDbStatus
}

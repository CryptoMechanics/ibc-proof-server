import { getFirehoseHeavyProof, preprocessFirehoseBlock, convertFirehoseAction, getFirehoseIrreversibleBlock } from "./firehoseFunctions";
import { getShipIrreversibleBlock, getShipHeavyProof } from "./shipFunctions";
import { getNodeosIrreversibleBlock, getNodeoseHeavyProof, convertNodeosAction, formatBlockRes } from "./nodeosFunctions";
import { getReceiptDigest } from "./ibcFunctions";
import { Proof } from "./types";
const historyProvider = process.env.HISTORY_PROVIDER;
const axios = require('axios');


//Functions that abstract the history provider
const getIrreversibleBlock = async (block_num) => {
  if (historyProvider === 'firehose') return getFirehoseIrreversibleBlock(block_num)
  else if (historyProvider === 'ship') return getShipIrreversibleBlock(block_num);
  else if (historyProvider === 'greymass') return getNodeosIrreversibleBlock(block_num);
}

const preprocessBlock = (obj, keepTraces) => {
  if (historyProvider === 'firehose') return preprocessFirehoseBlock(obj, keepTraces);
  else if (historyProvider === 'ship') return obj
  else if (historyProvider === 'greymass') return formatBlockRes(obj)
}

const convertAction = (act, block_num) => {
  if (historyProvider === 'firehose') return convertFirehoseAction(act);
  else if (historyProvider === 'ship') return act
  else if (historyProvider === 'greymass') return convertNodeosAction(act, block_num)
}


const getHeavyProof = async  (req): Promise<Proof> => {
  if (historyProvider === 'firehose') return getFirehoseHeavyProof(req);
  else if (historyProvider === 'ship') return getShipHeavyProof(req);
  else if (historyProvider === 'greymass'){
    const transactions = await getTxs(req.block_num+1); //since request includes previous block
    return getNodeoseHeavyProof(req, transactions);
  }
}

const getTxs = async res =>{
  if (historyProvider === 'firehose')  {
    let txs = res.block.unfilteredTransactionTraces.map(r=> r.actionTraces );
    for (var tx of txs){
      for (var act of tx){
        const converted = await convertAction(act, null);
        let action_receipt_digest = getReceiptDigest(converted.receipt);
        act.action = converted.action;
        act.receipt = converted.receipt;
        act.action_receipt_digest = action_receipt_digest;
      }
    }
    return txs;
  }
  else if (historyProvider === 'ship') {
    let txs = [];
    for (var tx of res.transactions){
      let traces = [];
      for (var act of tx.action_traces){
        let action_receipt_digest = getReceiptDigest(act.receipt);
        const converted = convertAction(act, null);
        act.action = JSON.parse(JSON.stringify(act.act));
        act.receipt = converted.receipt;
        act.action_receipt_digest = action_receipt_digest;
        act.transactionId = tx.id;
        delete act.act
        delete act.action.data
        traces.push(act)
      }
      //sort traces by global sequenece since SHIP doesnt sort them
      traces.sort((a,b)=> a.receipt.global_sequence > b.receipt.global_sequence? 1 :-1);
      txs.push(traces)
    }
    return txs;
  }
  else if (historyProvider === 'greymass') {
    const newRes = await axios(`${process.env.NODEOS_HTTP}/v1/history/get_raw_actions_in_block?block_num=${res.block_num || res}`);
    let txs =[];
    
    for (var action of newRes.data.actions){
      const converted = await convertAction(action, res.block_num || res);
      let action_receipt_digest = await getReceiptDigest(converted.receipt);

      let obj = {
        action_receipt_digest,
        transactionId: converted.action.transactionId,
        receipt: converted.receipt,
        action: {name: action.act.name}
      }
      let tx = txs.find(r=> r && r.find(s=>s.transactionId === obj.transactionId));
      if (!tx) txs.push([obj]);
      else tx.push(obj)
    }

    return txs;
  }
}

export {
  getIrreversibleBlock,
  preprocessBlock,
  convertAction,
  getHeavyProof,
  getTxs
}
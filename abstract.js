const { getFirehoseHeavyProof, preprocessFirehoseBlock, convertFirehoseAction, getFirehoseIrreversibleBlock } = require("./firehoseFunctions");
const { getShipIrreversibleBlock, getShipHeavyProof } = require("./shipFunctions");
const { getReceiptDigest } = require("./ibcFunctions")
const historyProvider = process.env.HISTORY_PROVIDER;


//Functions that abstract the history provider
const getIrreversibleBlock = async (block_num) => {
  if (historyProvider === 'firehose') return getFirehoseIrreversibleBlock(block_num)
  else if (historyProvider === 'ship') return getShipIrreversibleBlock(block_num);
}

const preprocessBlock = (obj, keepTraces) => {
  if (historyProvider === 'firehose') return preprocessFirehoseBlock(obj, keepTraces);
  else if (historyProvider === 'ship'){
    // console.log("obj",obj);
    return obj
  }
}

const convertAction = (act) => {
  if (historyProvider === 'firehose') return convertFirehoseAction(act);
  else if (historyProvider === 'ship') return act
}

const getHeavyProof = req => {
  if (historyProvider === 'firehose') return getFirehoseHeavyProof(req);
  else if (historyProvider === 'ship')return getShipHeavyProof(req);
}

const getTxs = res =>{
  if (historyProvider === 'firehose')  {
    let txs = res.block.unfilteredTransactionTraces.map(r=> r.actionTraces );
    for (var tx of txs){
      for (var act of tx){
        let action_receipt_digest = getReceiptDigest(act.receipt);
        const converted = convertAction(act);
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
        const converted = convertAction(act);
        act.action = JSON.parse(JSON.stringify(act.act));
        act.receipt = converted.receipt;
        act.action_receipt_digest = action_receipt_digest;
        act.transactionId = tx.id;
        delete act.act
        delete act.action.data
        traces.push(act)
      }
      txs.push(traces)

    }
    return txs;
  }
}





module.exports = {
  getIrreversibleBlock,
  preprocessBlock,
  convertAction,
  getHeavyProof,
  getTxs
}
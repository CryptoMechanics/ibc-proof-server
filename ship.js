const WebSocket = require('ws');
const { Serialize } = require('enf-eosjs');

class SHIP {
  constructor(cb) {
    this.abi = null;
    this.types = null;
    this.blocksQueue = [];
    this.inProcessBlocks = false;
    this.currentArgs = null;
    this.connectionRetries = 0;
    this.maxConnectionRetries = 100;
    this.cb = cb
  }

  start(endpoint,done){
    // console.log(`Websocket connecting to ${endpoint}`);
    this.ws = new WebSocket(endpoint, { perMessageDeflate: false });
    this.ws.on('message', async data =>{
      //if abi is not set, it means we are receiving an abi
      if (!this.abi) {
          this.rawabi = data;
          this.abi = JSON.parse(data);
          this.types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), this.abi);
          // console.log("this.types",this.types)
          if(done) done();
          //request ship status
          // return this.send(['get_status_request_v0', {}]);
      }else{
        //Receiving blocks
        const [type, response] = this.deserialize('result', data);
        await this[type](response);
      }
    });
    this.ws.on('close', code => {
      if (code!==1000) console.error(`Websocket disconnected from ${process.env.SHIP_WS} with code ${code}`);
      this.abi = null;
      this.types = null;
      this.blocksQueue = [];
      this.inProcessBlocks = false;
      if (code !== 1000) this.reconnect();
    });
    this.ws.on('error', (e) => {console.error(`Websocket error`, e)});
  }

  disconnect() {
      // console.log(`Closing connection`);
      this.ws.close();
  }

  reconnect(){
    if (this.connectionRetries > this.maxConnectionRetries) return console.error(`Exceeded max reconnection attempts of ${this.maxConnectionRetries}`);
    const timeout = Math.pow(2, this.connectionRetries/5) * 1000;
    console.log(`Retrying with delay of ${timeout / 1000}s`);
    setTimeout(() => { this.start(process.env.SHIP_WS); }, timeout);
    this.connectionRetries++;
  }

  serialize(type, value) {
    const buffer = new Serialize.SerialBuffer({ textEncoder: new TextEncoder, textDecoder: new TextDecoder });
    Serialize.getType(this.types, type).serialize(buffer, value);
    return buffer.asUint8Array();
  }

  deserialize(type, array) {
    const buffer = new Serialize.SerialBuffer({ textEncoder: new TextEncoder, textDecoder: new TextDecoder, array });
    return Serialize.getType(this.types, type).deserialize(buffer, new Serialize.SerializerState({ bytesAsUint8Array: true }));
  }

  toJsonUnpackTransaction(x) {
    return JSON.stringify(x, (k, v) => {
      if (k === 'trx' && Array.isArray(v) && v[0] === 'packed_transaction') {
          const pt = v[1];
        let packed_trx = pt.packed_trx;
        if (pt.compression === 0)
          packed_trx = this.deserialize('transaction', packed_trx);
        else if (pt.compression === 1)
          packed_trx = this.deserialize('transaction', zlib.unzipSync(packed_trx));
        return { ...pt, packed_trx };
      }
      if (k === 'packed_trx' && v instanceof Uint8Array)
        return this.deserialize('transaction', v);
      if (v instanceof Uint8Array)
        return `(${v.length} bytes)`;
      return v;
    }, 4)
  }

  send(request) {
    this.ws.send(this.serialize('request', request));
  }

  requestBlocks(requestArgs) {
    if (!this.currentArgs) this.currentArgs = {
      start_block_num: 0,
      end_block_num: 0xffffffff,
      max_messages_in_flight: 500,
      have_positions: [],
      irreversible_only: false,
      fetch_block: true,
      fetch_traces: true,
      fetch_deltas: false,
      ...requestArgs
    };
    this.send(['get_blocks_request_v0', this.currentArgs]);
  }

  async get_status_result_v0(response) {
    console.log("SHIP Lib is at ", response.last_irreversible.block_num);
    console.log("get_status_result_v0", response)
    // this.requestBlocks({ start_block_num, irreversible_only:false })
  }

  async get_blocks_result_v0(response) {
    if(!response.traces) return;
    let traces = this.deserialize("transaction_trace[]",response.traces);
    const block = this.deserialize("signed_block",response.block);
    let transactions = [];

    let header = {...block};
    delete header.transactions;
    delete header.block_extensions;
    delete header.producer_signature;

    for (var txRaw of traces) {
      let tx = txRaw[1];
      let action_traces = [];
      for (var t of tx.action_traces){
        let trace = t[1];
        trace.receipt = trace.receipt[1];
        action_traces.push(trace)
      }
      tx.action_traces = action_traces;
      transactions.push(tx)
    }
    
    return await this.cb({
      id:response.this_block.block_id,
      block_num:response.this_block.block_num,
      header,
      producer_signature: block.producer_signature,
      transactions,
    })
  }

} 


module.exports = SHIP
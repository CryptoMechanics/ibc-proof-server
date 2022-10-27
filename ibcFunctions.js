
const { SerialBuffer, createInitialTypes } = require("eosjs/dist/eosjs-serialize");
const types = createInitialTypes();
const crypto = require("crypto");
const hex64 = require('hex64');
const axios = require("axios");

const eosjsTypes = {
  name: types.get("name"), 
  bytes: types.get("bytes"), 
  uint8: types.get("uint8"), 
  uint16: types.get("uint16"), 
  uint32: types.get("uint32"), 
  uint64: types.get("uint64"), 
  varuint32: types.get("varuint32"), 
  checksum256: types.get("checksum256")
}

function getActionProof(block_to_prove, requested_action_receipt_digest){
  let { action_receipt_digests, action_return_value } = getReceiptDigests(block_to_prove, requested_action_receipt_digest);
  if (action_receipt_digests.length>1) action_receipt_digests = getProof(createTree(action_receipt_digests), requested_action_receipt_digest);
  return {
    amproofpath: action_receipt_digests,
    returnvalue: action_return_value && action_return_value.length ? action_return_value : ""
  };
}

function getBmProof(block_to_prove, last_proven_block ){
  return new Promise(async resolve=>{
    const blocksTofetch = [];
    
    let proofPath = getProofPath(block_to_prove-1, last_proven_block-1);
    for (var i = 0 ; i < proofPath.length; i++){
      var multiplier = Math.pow(2, i) ;
      var block_num = (proofPath[i].pairIndex + 1) * multiplier;  
      if (proofPath[i].pairIndex % 2 == 0 ) block_num+=1;
      block_num = Math.min(block_num, last_proven_block-1);
      blocksTofetch.push(block_num);
    }
    let result = (await axios(`${process.env.lightproofAPI}?blocks=${blocksTofetch.join(',')}`)).data;
    let bmproof = [];

    for (var i = 0 ; i < result.length;i++){
      const block = result[i];
      const path = i == 0 && (block_to_prove - 1) % 2 == 0 ? 1 :
                   i == 0 && (block_to_prove - 1) % 2 != 0 ? 2 :
                   proofPath[i].pairIndex % 2 == 0 ? 3 :
                   4;

      let hash;
      if ( path == 1 ) hash = block.id;
      else if ( path == 2 || path == 3 )  hash = block.nodes[0];
      else hash = append(block.id, block.nodes, block.num - 1, i).root;
      hash = applyMask(hash, proofPath[i].isLeft).toString("hex");
      bmproof.push(hash);
    }
    resolve(bmproof)
  })
}

function append(digest, _active_nodes, node_count, stop_at_depth = -1) {
  var partial = false;
  var max_depth = calculate_max_depth(node_count + 1);
  // var implied_count = next_power_of_2(node_count);

  var current_depth = stop_at_depth == -1 ? max_depth - 1 : stop_at_depth;
  var index = node_count;
  var top = digest;
  var count = 0;
  var updated_active_nodes = [];

  while (current_depth > 0) {

    if (!(index & 0x1)) {
      if (!partial) updated_active_nodes.push(top);
      top = hashPair(make_canonical_pair(top, top));
      partial = true;
    } 

    else {
      var left_value = _active_nodes[count];
      count++;
      if (partial)  updated_active_nodes.push(left_value);
      top = hashPair(make_canonical_pair(left_value, top));
     }

     current_depth--;
     index = index >> 1;
  }

  updated_active_nodes.push(top);
  return { nodes: updated_active_nodes, root: top };
}

function merkle(ids) {
  if( 0 == ids.length ) return ""; 

  while( ids.length > 1 ) {

     if( ids.length % 2 ) ids.push(ids[ids.length-1]);

     for (var i = 0; i < ids.length / 2; i++) {
       
       var p = make_canonical_pair(ids[2 * i], ids[(2 * i) + 1]);

       var buffLeft = Buffer.from(p.l, "hex")
       var buffRight = Buffer.from(p.r, "hex")

       var buffFinal = Buffer.concat([buffLeft, buffRight]);

       var finalHash = crypto.createHash("sha256").update(buffFinal).digest("hex");

       ids[i] = finalHash;

     }

     ids = ids.slice(0, ids.length / 2);

  }

  return ids[0];
}

function createTree(leaves, mask = true){

  var n_leaves = JSON.parse(JSON.stringify(leaves));
  var tree = { leaves, layers : [] }
  var layer_index = 0 ;

  while (n_leaves.length>1){

    if (n_leaves.length % 2) n_leaves.push(n_leaves[n_leaves.length-1]);
    tree.layers.push([]);

    for (var i = 0; i<n_leaves.length / 2; i++){
      
      var leftLeaf;
      var rightLeaf;

      if (mask){
        leftLeaf = maskLeft(n_leaves[2*i]);
        rightLeaf = maskRight(n_leaves[2*i+1]);
      }
      else {
        leftLeaf = n_leaves[2*i];
        rightLeaf = n_leaves[2*i+1];
      }

      tree.layers[layer_index].push(leftLeaf.toString("hex"));
      tree.layers[layer_index].push(rightLeaf.toString("hex"));

      var hash = crypto.createHash('sha256')
                       .update(Buffer.concat([Buffer.from(leftLeaf, "hex"), Buffer.from(rightLeaf, "hex")]))
                       .digest("hex");

      n_leaves[i] = hash;
    }

    n_leaves = n_leaves.slice(0, n_leaves.length / 2)
    layer_index++;
  }

  tree.root = n_leaves[0];
  return tree;
}

function verify (proof, targetNode, root, mask = true){

  var hash_count = 0;
  var hash = targetNode;

  //console.log("target : ", hash, "\n");

  for (let i = 0; i < proof.length; i++) {
  
    var node = proof[i];
    //console.log("node : ", node, "\n");

    var isLeft = isLeftNode(proof[i]);

    if (mask){
      node = isLeft ? maskLeft(node) : maskRight(node);
      hash = isLeft ? maskRight(hash) : maskLeft(hash);
    }
    //console.log("canonical node : ", node );
    //console.log("canonical hash : ", hash );

    var buffers = [];

    buffers.push(Buffer.from(hash, "hex"));
    buffers[ isLeft ? 'unshift' : 'push' ](Buffer.from(node, "hex"));

    var hash_hex = crypto.createHash('sha256').update(Buffer.concat(buffers)).digest("hex");
    //console.log("hash : ", hash_hex, "\n");

    hash_count++;
    hash = hash_hex;
  }

  return Buffer.compare(Buffer.from(hash, "hex"), Buffer.from(root, "hex")) === 0;
}

function getProof (tree, leaf) {

  var proof = [];
  var index = tree.leaves.findIndex(item => item == leaf);

  if (index <= -1) {
    console.log("Couldn't find leaf in tree");
    return []
  }

  for (var i = 0; i < tree.layers.length; i++) {
    const layer = tree.layers[i];

    const isLeft = index % 2;
    const pairIndex = isLeft ? index - 1 :
                      index === layer.length - 1 && i < tree.layers.length - 1 ? index :
                      index + 1;

    if (pairIndex < layer.length) proof.push( applyMask( layer[pairIndex], isLeft ) );
    index = (index / 2) | 0
  }

  return proof;
}

function getProofPath (index, nodes_count) {

  var proof = [];
  var layers_depth = calculate_max_depth(nodes_count) -1;
  var c_nodes_count = nodes_count;

  for (var i = 0; i < layers_depth; i++) {
    if (c_nodes_count%2) c_nodes_count+=1;

    const isLeft = index % 2;
    var pairIndex = isLeft ? index - 1 :
                    index === nodes_count - 1 && i < layers_depth - 1 ? index :
                    index + 1;

    c_nodes_count/=2;
    if (pairIndex < nodes_count) proof.push({layer : i, pairIndex, isLeft});

    index = (index / 2) | 0
  }

  return proof;
}

//Digests
function getReceiptDigests(block_to_prove, action_receipt_digest){
  let action_return_value;
  var action_receipt_digests = [];

  var transactions = block_to_prove.unfilteredTransactionTraces.map(item => item.actionTraces);

  for (traces of transactions){
    for (trace of traces){
    
      trace.action.rawData = hex64.toHex(trace.action.rawData);
      // console.log("Action : ", trace.action);

      var receipt_digest = getReceiptDigest(trace.receipt);

      //if this is the trace of the action we are trying to prove, assign the action_return_value from trace result
      if (receipt_digest === action_receipt_digest && trace.returnValue) action_return_value = hex64.toHex(trace.returnValue)
      action_receipt_digests.push(receipt_digest);
    }
  }

  var action_receipt_digests_clone = JSON.parse(JSON.stringify(action_receipt_digests));
  // console.log("action_receipt_digests : ", JSON.stringify(action_receipt_digests, null, 2));

  var actionMerkleRoot = merkle(action_receipt_digests_clone);
  // console.log("actionMerkleRoot : ", actionMerkleRoot);

  return { action_receipt_digests, action_return_value };
}

function getReceiptDigest(receipt){
  // console.log("getReceiptDigest receipt", receipt);
  const { name, uint8, uint64,varuint32, checksum256  } = eosjsTypes;

  const buffer = new SerialBuffer({ TextEncoder, TextDecoder });

  //handle different formats of receipt for dfuse (camelCase) and nodeos
  //if receipt is in nodeos format, convert to dfuse format
  if (receipt.act_digest && !receipt.digest){
    
    let authSequence = [];
    for (var auth of receipt.auth_sequence) authSequence.push({ accountName: auth[0], sequence: auth[1] })

    receipt = {
      receiver: receipt.receiver,
      digest: receipt.act_digest,
      globalSequence: receipt.global_sequence,
      recvSequence: receipt.recv_sequence,
      authSequence,
      codeSequence: receipt.code_sequence,
      abiSequence: receipt.abi_sequence,
    }

    // console.log("converted receipt", receipt)
  }
  // console.log("getReceiptDigest receipt", receipt);

  name.serialize(buffer, receipt.receiver);
  checksum256.serialize(buffer, receipt.digest);
  uint64.serialize(buffer, receipt.globalSequence);
  uint64.serialize(buffer, receipt.recvSequence);

  if (receipt.authSequence)  {
    varuint32.serialize(buffer, receipt.authSequence.length);
    for (var auth of receipt.authSequence){
      name.serialize(buffer, auth.accountName);
      uint64.serialize(buffer, auth.sequence);
    }
  }
  else varuint32.serialize(buffer, 0);

  if (receipt.codeSequence) varuint32.serialize(buffer, receipt.codeSequence);
  else varuint32.serialize(buffer, 0);

  if (receipt.abiSequence) varuint32.serialize(buffer, receipt.abiSequence);
  else varuint32.serialize(buffer, 0);

  return crypto.createHash("sha256").update(buffer.asUint8Array()).digest("hex");
}

function compressProof(obj){
  console.log("compressProof");
  const newObj = JSON.parse(JSON.stringify(obj));
  const hashes = [];
  let totalHashes = 0;
  for (var i = 0 ; i < newObj.proof.blockproof.blocktoprove.active_nodes.length; i++) {
      var node = newObj.proof.blockproof.blocktoprove.active_nodes[i];
      hashes.push(node);
      var node_index = hashes.length-1;
      newObj.proof.blockproof.blocktoprove.active_nodes[i] = node_index;
      totalHashes++;
  }

  for (var i = 0 ; i < newObj.proof.blockproof.bftproof.length; i++) {
    for (var j = 0 ; j < newObj.proof.blockproof.bftproof[i].bmproofpath.length; j++){
      var node = newObj.proof.blockproof.bftproof[i].bmproofpath[j];
      var node_index = hashes.indexOf(node);
      if (node_index==-1){ 
        hashes.push(node);
        node_index = hashes.length-1;
      }
      newObj.proof.blockproof.bftproof[i].bmproofpath[j] = node_index;
      totalHashes++;
    }

  }

  newObj.proof.blockproof.hashes = hashes;  

  var newSize = (hashes.length*32) + (totalHashes*2);
  var oldSize = totalHashes * 32;
  var compressionRatio = 1 - (newSize / oldSize);

  console.log("Compression ratio : ", compressionRatio);
  return newObj;
}

const applyMask = (node, isLeft) => isLeft ? maskLeft(node).toString("hex") : maskRight(node).toString("hex");

const make_canonical_pair = (l,r) => ({ l: maskLeft(l), r: maskRight(r) });

const isLeftNode = n => (Buffer.from(n, "hex"))[0] < 128;

function maskLeft(n){
  var nn = Buffer.from(n, "hex");
  nn[0] &= 0x7f;
  if (nn[0] < 0) nn[0] += (1 << 30) * 4;
  return nn;
}

function maskRight(n){
  var nn = Buffer.from(n, "hex");
  nn[0] |= 0x80;
  if (nn[0] < 0) nn[0] += (1 << 30) * 4;
  return nn;
}

function next_power_of_2( value) {
  value -= 1;
  value |= value >> 1;
  value |= value >> 2;
  value |= value >> 4;
  value |= value >> 8;
  value |= value >> 16;
  value |= value >> 32;
  value += 1;   
  return value;
}

function clz_power_2( value) {
  var count = 1;

  for (var i = 0; i < 30; i++){
    count*=2;
    if (value == count) return i+1;
  }

  return 0;
}

function calculate_max_depth( node_count) {
   if (node_count == 0) return 0;
   var implied_count = next_power_of_2(node_count);
   return clz_power_2(implied_count) + 1;
}

function hashPair(p){
  var buffLeft = Buffer.from(p.l, "hex")
  var buffRight = Buffer.from(p.r, "hex")

  var buffFinal = Buffer.concat([buffLeft, buffRight]);
  var finalHash = crypto.createHash("sha256").update(buffFinal).digest("hex");

  return finalHash;
}

module.exports = {
  getActionProof,
  getBmProof,
  verify,
  compressProof,
  getReceiptDigest
}
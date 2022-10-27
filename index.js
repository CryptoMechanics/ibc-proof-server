require('dotenv').config(); 
//create websocket server
const WebSocketServer = require('ws');
const websocketPort = process.env.port;

//import websocket message handlers
const { handleHeavyProof, handleLightProof, handleGetBlockActions } = require("./handlers");

const { closeClientStreams } = require("./firehoseFunctions");

//main process handling websocket connections
const main = async ()=> {
  //initiate websocket server
  const wss = new WebSocketServer.Server({ port: websocketPort });

  //on new connection handler
  wss.on("connection", (ws, req) => {
    ws.id = req.headers['sec-websocket-key'];
    console.log("new ws connected");

    ws.on("message", async (message) => {
      console.log("message",message.toString());
      let supportedTypes = ['lightProof', 'heavyProof', 'getBlockActions'];
      //ensure message is in the right format
      let msgObj;
      try{ msgObj = JSON.parse(message.toString())}
      catch(ex){ return ws.send(JSON.stringify({ type:"error", error: "Message needs to be a stringified object" })); }
      
      if (!supportedTypes.includes(msgObj.type)) return ws.send(JSON.stringify({ type:"error", error: "Message needs to include request types:" + supportedTypes.join(',') }));
      if(isNaN(msgObj.block_to_prove)) return ws.send(JSON.stringify({ type:"error", error: "Must supply block_to_prove number"  }));
      
      //handle request according to type
      if (msgObj.type == "lightProof") {
        if(isNaN(msgObj.last_proven_block)) return ws.send(JSON.stringify({ type:"error", error: "Must supply last_proven_block number"  }));
        handleLightProof(msgObj, ws);
      }
      else if (msgObj.type == "heavyProof") handleHeavyProof(msgObj, ws);
      else if (msgObj.type == "getBlockActions") handleGetBlockActions(msgObj, ws);
      // else if (msgObj.type == "getBlockRange") handleGetBlockRange(msgObj,ws);
    });

    //find and close existing firehose streams if socket client disconnects
    ws.on("close", () => {
      console.log("the ws has disconnected");
      closeClientStreams(ws.id);
    });

    ws.onerror = function (e) { console.log("Error".e) }
  });
  console.log("Listening on", websocketPort)
}

var signals = {
  'SIGHUP': 1,
  'SIGINT': 2,
  'SIGTERM': 15
};
Object.keys(signals).forEach((signal) => {
  process.on(signal, () => {
    console.log(`process received a ${signal} signal`);
    let value = signals[signal];
    process.exit(128 + value);
  });
});

main().catch(error => {
  console.log("unhandled error main", error)
  process.exit(1);
});

process.on("unhandledRejection", function (reason, p) {
  let message = reason ? reason.stack : reason;
  console.error(`Possibly Unhandled Rejection at: ${message}`);
  process.exit(1);
});
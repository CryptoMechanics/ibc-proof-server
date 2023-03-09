# ibc-proof-server

ibc-proof-server generates and serves heavy and light proofs for actions and schedules. Currently firehose and SHIP are supported.

## Instructions

#### Clone the repo and install dependencies

```
git clone https://github.com/eostitan/ibc-proof-server.git
cd ibc-proof-server
git checkout v2
npm install
```

#### Configuration

- `cp .env.example .env`

- edit the `.env` file variables with the desired chain parameters

```
#host port to use for ibc-proof-server websocket
PORT=7788

#chain id of the chain that ibc-proof-server provides proofs for
CHAIN_ID="aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906"

# lightproof-db endpoint                                    
LIGHTPROOF_API=http://localhost:8285   

# The history provider to fetch from (firehose/ship) 
HISTORY_PROVIDER=ship

#firehose history provider config
GRPC_ADDRESS=eos.firehose.eosnation.io:9000                 
GRPC_INSECURE=false     

#ship history provider config
SHIP_WS=ws://192.168.86.41:8080
```


#### Run
```
node index.js
```

# ibc-proof-server

ibc-proof-server generates and serves heavy and light proofs for actions and schedules. Currently firehose, SHIP and greymass are supported.

## Instructions

#### Clone the repo and install dependencies

```
git clone https://github.com/CryptoMechanics/ibc-proof-server.git
cd ibc-proof-server
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

# The history provider to fetch from (firehose/ship/greymass) 
HISTORY_PROVIDER=ship

# Firehose GRPC address and mode (if HISTORY_PROVIDER is firehose)
GRPC_ADDRESS=eos.firehose.eosnation.io:9000                 
GRPC_INSECURE=false

# SHIP websocket address (if HISTORY_PROVIDER is ship)
SHIP_WS=ws://localhost:8080

# Nodeos HTTP (if HISTORY_PROVIDER is greymass)
NODEOS_HTTP=http://localhost:8888

# only required for greymass; Block in which the ACTION RETURN feature was activated
RETURN_VALUE_ACTIVATION = 269183455

```


#### Run
```
node index.js
```

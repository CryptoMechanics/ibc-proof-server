# ibc-proof-server

ibc-proof-server generates and serves heavy and light proofs for actions and schedules. Currently only firehose is supported.

## Instructions

#### Clone the repo and install dependencies

```
git clone https://github.com/eostitan/ibc-proof-server.git
cd ibc-proof-server
npm install
```

#### Configuration

- `cp .env.example .env`

- edit the `.env` file variables with the desired chain parameters

```
PORT=7788                                    #host port to use for http (consumed by ibc-proof-server)
LIGHTPROOF_API=http://localhost::8285        #lightproof-db endpoint
GRPC_ADDRESS=eos.firehose.eosnation.io:9000  #GRPC address of firehose service (ideally on local network/machine)
GRPC_INSECURE=false                          #set to true if connecting to insecure GRPC service (vs TLS)
CHAIN_ID="aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906"
```


#### Run
```
node index.js
```

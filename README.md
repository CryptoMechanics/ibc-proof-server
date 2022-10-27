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
port=7788                                   #host port to use for http (consumed by ibc-proof-server)
lightproofAPI=http://localhost::8285        #lightproof-db endpoint        
grpcAddress=eos.firehose.eosnation.io:9000  #GRPC address of firehose service (ideally on local network/machine)
grpcInsecure=false                          #set to true if connecting to insecure GRPC service (vs TLS)
firehoseMinBlock=0                          #lowest block available in firehose
nodeosApi=https://eos.api.eosnation.io      #regular nodeos api (/v1/chain/)
chain_id=aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906
```


#### Run
```
node index.js
```

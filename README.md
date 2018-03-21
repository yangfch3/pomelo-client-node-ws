# pomelo-client-node
Pomelo 客户端的 Node.js 实现，适用于 `hybridconnector` 型 `connector`。

## Features
1. 支持多 pomelo 客户端实例的创建
2. 与浏览器端 pomelo 客户端保持相同 API
3. `wss` 协议支持

## Usage
```
npm i pomelo-client-node-ws
```

```
const Pomelo = require('pomelo-client-websocket-node');
const pomelo = new Pomelo();

pomelo.init({
    host: '192.168.1.20',
    port: 3010,
    scheme: 'ws'
}, () => {
    pomelo.request('gate.gateHandler.queryEntry', {
        uid: 234234232
    }, (data) => {
        console.log(data);
        pomelo.disconnect();
        if(data.code === 500) {
            console.error('gate 连接失败');
            return;
        }
        pomelo.init({
            host: data.hosts,
            port: data.port,
            scheme: 'wss'
        }, () => {
            // ...
        });
    });
});

pomelo.on('loginRes', (data) => {
    console.log(data);
})
```

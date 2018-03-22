# pomelo-client-node-ws
Pomelo 客户端的 Node.js 实现，适用于 `hybridconnector` 型 `connector`。

## Features
1. 支持多 pomelo 客户端实例的创建
2. 与浏览器端 pomelo 客户端保持相同 API
3. `wss` 协议支持
4. `protobuf` 支持
5. 客户端实例新增 `__CLIENT_ROUTE` 用于对所有服务器端推送消息进行统一处理

## Usage
```
npm i pomelo-client-node-ws
```

```javascript
const Pomelo = require('pomelo-client-node-ws');
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
});

// Feature: 对所有服务端推送消息的统一处理
pomelo.on('__CLIENT_ROUTE', (route, data) => {
    console.log(route);
    console.log(data);
});
```

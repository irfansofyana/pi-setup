// Import only inside isolated child process. Test harness must never reach a provider network.
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
function forbidden() { throw new Error("offline smoke: network forbidden"); }
globalThis.fetch = forbidden;
net.connect = forbidden;
net.createConnection = forbidden;
net.Socket.prototype.connect = forbidden;
tls.connect = forbidden;
http.request = forbidden;
http.get = forbidden;
https.request = forbidden;
https.get = forbidden;
dgram.createSocket = forbidden;
dns.lookup = forbidden;
dns.resolve = forbidden;
syncBuiltinESMExports();

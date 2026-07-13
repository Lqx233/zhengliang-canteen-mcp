import http from "node:http";
import { WIZARD_CSS, WIZARD_HTML, WIZARD_JS } from "../build/src/ui/wizardPage.js";

const server = http.createServer((request, response) => {
  if (request.url?.startsWith("/style.css")) { response.writeHead(200, { "Content-Type": "text/css" }); return response.end(WIZARD_CSS); }
  if (request.url?.startsWith("/app.js")) { response.writeHead(200, { "Content-Type": "text/javascript" }); return response.end(WIZARD_JS); }
  if (request.url?.startsWith("/api/discovery")) { response.writeHead(200, { "Content-Type": "application/json" }); return response.end(JSON.stringify({ warehouses: [{ warehouseId: "warehouse-A", warehouseName: "Warehouse A", receiver: "", receiverPhone: "", nutrition: 0, remark: "Warehouse A" }] })); }
  if (request.url?.startsWith("/api/save")) { response.writeHead(200, { "Content-Type": "application/json" }); return response.end(JSON.stringify({ saved: true })); }
  response.writeHead(200, { "Content-Type": "text/html" }); response.end(WIZARD_HTML);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`http://127.0.0.1:${address.port}/?nonce=preview\n`);
});

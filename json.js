const http = require('http');
const ngrok = require('@ngrok/ngrok');

// Create webserver
http.createServer((req, res) => {
	res.writeHead(200, { 'Content-Type': 'text/html' });
	res.end('Congrats you have created an ngrok web server');
}).listen(3000, () => console.log('Node.js web server at 3000 is running...'));

// Get your endpoint online
ngrok.connect({ addr: 3000, authtoken_from_env: true })
	.then(listener => console.log(`Ingress established at: ${listener.url()}`));
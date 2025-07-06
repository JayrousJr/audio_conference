const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = socketIo(server, {
	cors: {
		origin: "*",
		methods: ["GET", "POST"],
		credentials: true,
	},
	transports: ["websocket", "polling"],
});

// Store streaming sessions
const streamingSessions = new Map();

io.on("connection", (socket) => {
	console.log(`📱 Mobile app connected: ${socket.id}`);

	// Test ping
	socket.on("test:ping", (data) => {
		console.log(`📡 Test ping received from ${socket.id}:`, data.message);
		socket.emit("test:pong", { message: "Server received your ping!" });
	});

	// Streaming started
	socket.on("streaming:start", (data) => {
		console.log(`🎤 STREAMING STARTED from ${socket.id}`);
		console.log(`📊 Format: ${data.format}, MIME: ${data.mimeType}`);

		streamingSessions.set(socket.id, {
			startTime: Date.now(),
			totalChunks: 0,
			totalBytes: 0,
			format: data.format,
			mimeType: data.mimeType,
		});
	});

	// Audio chunk received (live streaming)
	socket.on("audio:chunk", (data) => {
		const session = streamingSessions.get(socket.id);

		if (session) {
			session.totalChunks++;
			session.totalBytes += data.size || 0;

			const chunkSizeKB = data.size ? (data.size / 1024).toFixed(1) : "0";
			const elapsedTime = ((Date.now() - session.startTime) / 1000).toFixed(1);

			console.log(`🎵 LIVE CHUNK #${data.chunkNumber} received:`);
			console.log(`   📏 Size: ${chunkSizeKB}KB`);
			console.log(`   🎚️ Format: ${data.format}`);
			console.log(`   ⏱️ Elapsed: ${elapsedTime}s`);
			console.log(`   📊 Total chunks: ${session.totalChunks}`);

			// Simulate what the admin panel would do
			console.log(
				`   🔊 >> Playing chunk ${data.chunkNumber} on admin panel <<`
			);

			// Send acknowledgment
			socket.emit("audio:chunk:ack", {
				chunkNumber: data.chunkNumber,
				received: true,
				timestamp: Date.now(),
			});

			// Here you would normally broadcast to admin panels
			// socket.broadcast.emit('audio:stream', data);
		} else {
			console.log(`❌ Received chunk but no active session for ${socket.id}`);
		}
	});

	// Streaming ended
	socket.on("streaming:end", (data) => {
		const session = streamingSessions.get(socket.id);

		if (session) {
			const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
			const totalMB = (session.totalBytes / (1024 * 1024)).toFixed(2);

			console.log(`🛑 STREAMING ENDED from ${socket.id}`);
			console.log(`📊 Session Summary:`);
			console.log(`   ⏱️ Duration: ${duration} seconds`);
			console.log(`   📦 Total chunks: ${session.totalChunks}`);
			console.log(`   📏 Total data: ${totalMB}MB`);
			console.log(`   🎚️ Format: ${session.format}`);

			streamingSessions.delete(socket.id);
		}
	});

	// Disconnect
	socket.on("disconnect", () => {
		console.log(`📱 Mobile app disconnected: ${socket.id}`);

		if (streamingSessions.has(socket.id)) {
			console.log(`🛑 Cleaning up streaming session for ${socket.id}`);
			streamingSessions.delete(socket.id);
		}
	});
});

// Simple web interface to show what's happening
app.get("/", (req, res) => {
	const activeSessions = streamingSessions.size;

	res.send(`
    <html>
      <head>
        <title>Audio Streaming Server</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .status { background: #f0f8ff; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .live { background: #ffe4e1; border-left: 4px solid #ff6b6b; }
          h1 { color: #333; }
          .metric { margin: 10px 0; }
        </style>
      </head>
      <body>
        <h1>🎵 Audio Streaming Server</h1>
        
        <div class="status">
          <h2>📊 Server Status</h2>
          <div class="metric">🟢 Server is running</div>
          <div class="metric">📱 Active streaming sessions: ${activeSessions}</div>
          <div class="metric">⏰ Server time: ${new Date().toLocaleString()}</div>
        </div>
        
        <div class="status live">
          <h2>🔴 Live Streaming</h2>
          <p>When you start streaming from the mobile app, you'll see real-time logs in the server console showing:</p>
          <ul>
            <li>📦 Each audio chunk as it arrives</li>
            <li>📏 Chunk sizes and formats</li>
            <li>🎵 Simulated playback on admin panel</li>
            <li>📊 Session statistics</li>
          </ul>
        </div>
        
        <div class="status">
          <h2>🔧 How to Test</h2>
          <ol>
            <li>Open the mobile app</li>
            <li>Wait for "Connected" status</li>
            <li>Tap "Start Streaming"</li>
            <li>Speak continuously</li>
            <li>Watch this console for real-time logs</li>
            <li>Tap "Stop Streaming" when done</li>
          </ol>
        </div>
        
        <script>
          // Auto-refresh every 5 seconds to show updated session count
          setTimeout(() => location.reload(), 5000);
        </script>
      </body>
    </html>
  `);
});

// Health check
app.get("/health", (req, res) => {
	res.json({
		status: "ok",
		activeSessions: streamingSessions.size,
		timestamp: Date.now(),
	});
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
	console.log(`🚀 Audio Streaming Server running on http://${HOST}:${PORT}`);
	console.log(`🌐 Web interface: http://${HOST}:${PORT}/admin`);
	console.log(`❤️  Health check: http://${HOST}:${PORT}/health`);
	console.log(`📡 Waiting for mobile app connections...`);
});

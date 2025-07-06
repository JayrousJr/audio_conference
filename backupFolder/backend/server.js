const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const path = require("path");

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

// Store streaming sessions and admin connections
const streamingSessions = new Map();
const adminConnections = new Set();

io.on("connection", (socket) => {
	console.log(`📱 Device connected: ${socket.id}`);

	// Admin connection (when someone opens the admin panel)
	socket.on("admin:connect", () => {
		console.log(`👨‍💼 Admin connected: ${socket.id}`);
		adminConnections.add(socket.id);
		socket.emit("admin:connected", { message: "Admin panel connected" });
	});

	// Test ping (from mobile or admin)
	socket.on("test:ping", (data) => {
		console.log(`📡 Test ping received from ${socket.id}:`, data.message);
		socket.emit("test:pong", { message: "Server received your ping!" });
	});

	// Streaming started (from mobile)
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

		// Broadcast to all admin panels
		adminConnections.forEach((adminId) => {
			io.to(adminId).emit("streaming:start", data);
		});
	});

	// Audio chunk received (from mobile) - BROADCAST TO ADMINS
	socket.on("audio:chunk", (data) => {
		const session = streamingSessions.get(socket.id);

		if (session) {
			session.totalChunks++;
			session.totalBytes += data.size || 0;

			const chunkSizeKB = data.size ? (data.size / 1024).toFixed(1) : "0";
			const elapsedTime = ((Date.now() - session.startTime) / 1000).toFixed(1);

			console.log(`🎵 LIVE CHUNK #${data.chunkNumber} received:`);
			console.log(`📏 Size: ${chunkSizeKB}KB`);
			console.log(`🎚️ Format: ${data.format}`);
			console.log(`⏱️ Elapsed: ${elapsedTime}s`);
			console.log(`📊 Total chunks: ${session.totalChunks}`);
			console.log(`👨‍💼 Broadcasting to ${adminConnections.size} admin(s)`);

			// Send acknowledgment to mobile app
			socket.emit("audio:chunk:ack", {
				chunkNumber: data.chunkNumber,
				received: true,
				timestamp: Date.now(),
			});

			// 🔊 BROADCAST AUDIO CHUNK TO ALL ADMIN PANELS
			adminConnections.forEach((adminId) => {
				io.to(adminId).emit("audio:chunk", {
					...data,
					receivedAt: Date.now(),
					sessionId: socket.id,
				});
			});
		} else {
			console.log(`❌ Received chunk but no active session for ${socket.id}`);
		}
	});

	// Streaming ended (from mobile)
	socket.on("streaming:end", (data) => {
		const session = streamingSessions.get(socket.id);

		if (session) {
			const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
			const totalMB = (session.totalBytes / (1024 * 1024)).toFixed(2);

			console.log(`🛑 STREAMING ENDED from ${socket.id}`);
			console.log(`📊 Session Summary:`);
			console.log(`⏱️ Duration: ${duration} seconds`);
			console.log(`📦 Total chunks: ${session.totalChunks}`);
			console.log(`📏 Total data: ${totalMB}MB`);
			console.log(`🎚️ Format: ${session.format}`);

			// Broadcast to admin panels
			adminConnections.forEach((adminId) => {
				io.to(adminId).emit("streaming:end", {
					...data,
					sessionSummary: {
						duration: duration,
						totalChunks: session.totalChunks,
						totalMB: totalMB,
						format: session.format,
					},
				});
			});

			streamingSessions.delete(socket.id);
		}
	});

	// Disconnect
	socket.on("disconnect", () => {
		console.log(`📱 Device disconnected: ${socket.id}`);

		// Remove from admin connections
		adminConnections.delete(socket.id);

		// Clean up streaming session if exists
		if (streamingSessions.has(socket.id)) {
			console.log(`🛑 Cleaning up streaming session for ${socket.id}`);

			// Notify admins that streaming ended unexpectedly
			adminConnections.forEach((adminId) => {
				io.to(adminId).emit("streaming:end", {
					totalChunks: streamingSessions.get(socket.id)?.totalChunks || 0,
					timestamp: Date.now(),
					reason: "disconnected",
				});
			});

			streamingSessions.delete(socket.id);
		}
	});
});

// Simple web interface to show what's happening
app.get("/", (req, res) => {
	const activeSessions = streamingSessions.size;
	const activeAdmins = adminConnections.size;

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
          .btn { 
            display: inline-block; 
            padding: 10px 20px; 
            background: #007bff; 
            color: white; 
            text-decoration: none; 
            border-radius: 5px; 
            margin: 10px 5px;
          }
        </style>
      </head>
      <body>
        <h1>🎵 Audio Streaming Server</h1>
        
        <div class="status">
          <h2>📊 Server Status</h2>
          <div class="metric">🟢 Server is running</div>
          <div class="metric">📱 Active streaming sessions: ${activeSessions}</div>
          <div class="metric">👨‍💼 Connected admins: ${activeAdmins}</div>
          <div class="metric">⏰ Server time: ${new Date().toLocaleString()}</div>
        </div>
        
        <div class="status live">
          <h2>🔴 Live Audio Admin Panel</h2>
          <p>Open the admin panel to hear live audio from mobile apps:</p>
          <a href="/admin" class="btn">🎧 Open Live Audio Admin Panel</a>
        </div>
        
        <div class="status">
          <h2>🔧 How to Test</h2>
          <ol>
            <li><strong>Open Admin Panel:</strong> Click the button above</li>
            <li><strong>Enable Audio:</strong> Click "Enable Audio" in the admin panel</li>
            <li><strong>Start Mobile App:</strong> Run the mobile streaming app</li>
            <li><strong>Start Streaming:</strong> Tap "Start Streaming" on mobile</li>
            <li><strong>Listen:</strong> You'll hear live audio in the admin panel!</li>
          </ol>
        </div>
        
        <script>
          // Auto-refresh every 30 seconds
          setTimeout(() => location.reload(), 30000);
        </script>
      </body>
    </html>
  `);
});

// Serve the live audio admin panel
app.get("/admin", (req, res) => {
	res.sendFile(path.join(__dirname, "public/admin.html"));
});

// Health check
app.get("/health", (req, res) => {
	res.json({
		status: "ok",
		activeSessions: streamingSessions.size,
		activeAdmins: adminConnections.size,
		timestamp: Date.now(),
	});
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
	console.log(`🚀 Audio Streaming Server running on http://${HOST}:${PORT}`);
	console.log(`🌐 Web interface: http://${HOST}:${PORT}`);
	console.log(`🎧 Admin panel: http://${HOST}:${PORT}/admin`);
	console.log(`❤️  Health check: http://${HOST}:${PORT}/health`);
	console.log(`📡 Waiting for connections...`);
});

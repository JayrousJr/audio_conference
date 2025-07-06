const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const io = socketIo(server, {
	cors: {
		origin: "*",
		methods: ["GET", "POST"],
		credentials: true,
	},
	transports: ["websocket", "polling"],
});

// Conference state management
const state = {
	queue: [],
	activeSpeaker: null,
	admins: new Map(),
	users: new Map(),
	speakerTimeout: null,
	streamingSessions: new Map(),
	settings: {
		maxQueueSize: 50,
		maxSpeakingTime: 300000, // 5 minutes
	},
};

// Serve admin panel
app.get("/admin", (req, res) => {
	res.sendFile(path.join(__dirname, "public/admin.html"));
});

// API endpoints
app.get("/api/status", (req, res) => {
	res.json({
		queueLength: state.queue.length,
		activeSpeaker: state.activeSpeaker?.name || null,
		connectedUsers: state.users.size,
		connectedAdmins: state.admins.size,
		streamingSessions: state.streamingSessions.size,
	});
});

// Socket.io connection handling
io.on("connection", (socket) => {
	// Admin connection
	socket.on("admin:connect", () => {
		state.admins.set(socket.id, {
			id: socket.id,
			connectedAt: Date.now(),
		});
		socket.join("admins");
		socket.emit("admin:connected", { message: "Admin connected" });
		sendStateUpdate();
	});

	// User joins conference
	socket.on("user:join", (data) => {
		const { name, deviceId } = data;

		if (!name || name.trim().length < 2) {
			socket.emit("user:join:failed", { error: "Invalid name" });
			return;
		}

		state.users.set(socket.id, {
			id: socket.id,
			name: name.trim(),
			deviceId,
			joinedAt: Date.now(),
			isInQueue: false,
			isSpeaking: false,
		});

		socket.emit("user:joined", { userId: socket.id });
		sendStateUpdate();

		// Notify admins
		io.to("admins").emit("user:connected", {
			id: socket.id,
			name: name.trim(),
			deviceId,
			joinedAt: Date.now(),
		});
	});

	// User requests to speak
	socket.on("user:request:speak", () => {
		const user = state.users.get(socket.id);
		if (!user) {
			socket.emit("error", { message: "User not found" });
			return;
		}

		if (user.isInQueue || user.isSpeaking) {
			socket.emit("error", { message: "Already in queue or speaking" });
			return;
		}

		if (state.queue.length >= state.settings.maxQueueSize) {
			socket.emit("error", { message: "Queue is full" });
			return;
		}

		user.isInQueue = true;
		user.requestedAt = Date.now();
		state.queue.push(socket.id);

		socket.emit("user:queued", { position: state.queue.length });
		sendStateUpdate();
	});

	// Admin accepts user to speak
	socket.on("admin:accept:user", (data) => {
		if (!state.admins.has(socket.id)) {
			socket.emit("error", { message: "Unauthorized" });
			return;
		}

		const { userId } = data;
		const userIndex = state.queue.indexOf(userId);

		if (userIndex === -1) {
			socket.emit("error", { message: "User not in queue" });
			return;
		}

		// Remove from queue
		state.queue.splice(userIndex, 1);

		const user = state.users.get(userId);
		if (!user) return;

		// End current speaker if any
		if (state.activeSpeaker) {
			endActiveSpeaker();
		}

		// Set as active speaker
		user.isInQueue = false;
		user.isSpeaking = true;
		state.activeSpeaker = {
			userId,
			name: user.name,
			startTime: Date.now(),
		};

		// Notify user they can start speaking
		io.to(userId).emit("user:speaking:start");
		io.to("admins").emit("speaker:started", state.activeSpeaker);

		// Set speaking timeout
		state.speakerTimeout = setTimeout(() => {
			endActiveSpeaker();
		}, state.settings.maxSpeakingTime);

		sendStateUpdate();
	});

	// Admin rejects user
	socket.on("admin:reject:user", (data) => {
		if (!state.admins.has(socket.id)) {
			socket.emit("error", { message: "Unauthorized" });
			return;
		}

		const { userId } = data;
		const userIndex = state.queue.indexOf(userId);

		if (userIndex !== -1) {
			state.queue.splice(userIndex, 1);
			const user = state.users.get(userId);
			if (user) {
				user.isInQueue = false;
				io.to(userId).emit("user:request:rejected");
			}
			sendStateUpdate();
		}
	});

	// Admin ends speaker
	socket.on("admin:end:speaker", () => {
		if (!state.admins.has(socket.id)) {
			socket.emit("error", { message: "Unauthorized" });
			return;
		}
		endActiveSpeaker();
	});

	// Audio streaming started
	socket.on("streaming:start", (data) => {
		const user = state.users.get(socket.id);
		if (!user || !user.isSpeaking) {
			socket.emit("error", { message: "Not authorized to stream audio" });
			return;
		}

		state.streamingSessions.set(socket.id, {
			userId: socket.id,
			userName: user.name,
			startTime: Date.now(),
			totalChunks: 0,
			totalBytes: 0,
			format: data.format,
			mimeType: data.mimeType,
		});

		// Broadcast to all admins
		io.to("admins").emit("streaming:start", {
			...data,
			userId: socket.id,
			userName: user.name,
		});
	});

	// Audio chunk received
	socket.on("audio:chunk", (data) => {
		const user = state.users.get(socket.id);
		if (!user || !user.isSpeaking) {
			socket.emit("error", { message: "Not authorized to send audio" });
			return;
		}

		const session = state.streamingSessions.get(socket.id);
		if (session) {
			session.totalChunks++;
			session.totalBytes += data.size || 0;

			// Send acknowledgment
			socket.emit("audio:chunk:ack", {
				chunkNumber: data.chunkNumber,
				received: true,
				timestamp: Date.now(),
			});

			// Broadcast to all admin panels
			io.to("admins").emit("audio:chunk", {
				...data,
				userId: socket.id,
				userName: user.name,
				receivedAt: Date.now(),
				sessionId: socket.id,
			});
		}
	});

	// Audio streaming ended
	socket.on("streaming:end", (data) => {
		const session = state.streamingSessions.get(socket.id);
		const user = state.users.get(socket.id);

		if (session) {
			const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
			const totalMB = (session.totalBytes / (1024 * 1024)).toFixed(2);

			// Broadcast to admin panels
			io.to("admins").emit("streaming:end", {
				...data,
				userId: socket.id,
				userName: user?.name,
				sessionSummary: {
					duration: duration,
					totalChunks: session.totalChunks,
					totalMB: totalMB,
					format: session.format,
				},
			});

			state.streamingSessions.delete(socket.id);
		}
	});

	// User ends speaking voluntarily
	socket.on("user:speaking:end", () => {
		if (state.activeSpeaker && state.activeSpeaker.userId === socket.id) {
			endActiveSpeaker();
		}
	});

	// Disconnect handling
	socket.on("disconnect", () => {
		// Remove from admins
		if (state.admins.has(socket.id)) {
			state.admins.delete(socket.id);
		}

		// Remove from users
		if (state.users.has(socket.id)) {
			const user = state.users.get(socket.id);

			// Remove from queue
			const queueIndex = state.queue.indexOf(socket.id);
			if (queueIndex !== -1) {
				state.queue.splice(queueIndex, 1);
			}

			// End if speaking
			if (state.activeSpeaker && state.activeSpeaker.userId === socket.id) {
				endActiveSpeaker();
			}

			// Clean up streaming session
			if (state.streamingSessions.has(socket.id)) {
				// Notify admins that streaming ended
				io.to("admins").emit("streaming:end", {
					userId: socket.id,
					userName: user.name,
					totalChunks: state.streamingSessions.get(socket.id)?.totalChunks || 0,
					timestamp: Date.now(),
					reason: "disconnected",
				});

				state.streamingSessions.delete(socket.id);
			}

			state.users.delete(socket.id);
		}

		sendStateUpdate();
	});
});

// Helper functions
function endActiveSpeaker() {
	if (!state.activeSpeaker) return;

	const { userId } = state.activeSpeaker;
	const user = state.users.get(userId);

	// Clear timeout if exists
	if (state.speakerTimeout) {
		clearTimeout(state.speakerTimeout);
		state.speakerTimeout = null;
	}

	// Update user state
	if (user) {
		user.isSpeaking = false;
		io.to(userId).emit("user:speaking:end");
	}

	// Clean up streaming session if exists
	if (state.streamingSessions.has(userId)) {
		// Notify admins that streaming ended
		io.to("admins").emit("streaming:end", {
			userId: userId,
			userName: user?.name,
			totalChunks: state.streamingSessions.get(userId)?.totalChunks || 0,
			timestamp: Date.now(),
			reason: "speaker_ended",
		});

		state.streamingSessions.delete(userId);
	}

	// Notify admins
	io.to("admins").emit("speaker:ended", state.activeSpeaker);
	state.activeSpeaker = null;

	sendStateUpdate();
}

function sendStateUpdate() {
	try {
		const stateUpdate = {
			queue: state.queue
				.map((id) => {
					const user = state.users.get(id);
					return user
						? {
								id,
								name: user.name,
								requestedAt: user.requestedAt,
								waitTime: Date.now() - user.requestedAt,
						  }
						: null;
				})
				.filter(Boolean),
			activeSpeaker: state.activeSpeaker
				? {
						userId: state.activeSpeaker.userId,
						name: state.activeSpeaker.name,
						startTime: state.activeSpeaker.startTime,
						duration: Date.now() - state.activeSpeaker.startTime,
				  }
				: null,
			stats: {
				totalUsers: state.users.size,
				totalAdmins: state.admins.size,
				queueLength: state.queue.length,
				activeSessions: state.streamingSessions.size,
			},
			connectedUsers: Array.from(state.users.values()).map((user) => ({
				id: user.id,
				name: user.name,
				joinedAt: user.joinedAt,
				isInQueue: user.isInQueue,
				isSpeaking: user.isSpeaking,
				deviceId: user.deviceId,
			})),
		};

		io.to("admins").emit("state:update", stateUpdate);
	} catch (error) {
		// Silent error handling in production
	}
}

// Simple web interface
app.get("/", (req, res) => {
	const activeSessions = state.streamingSessions.size;
	const activeAdmins = state.admins.size;
	const totalUsers = state.users.size;
	const queueLength = state.queue.length;

	res.send(`
		<html>
			<head>
				<title>Conference Server</title>
				<style>
					body { 
						font-family: Arial, sans-serif; 
						margin: 40px;
						background: #f5f5f5;
					}
					.container {
						max-width: 800px;
						margin: 0 auto;
						background: white;
						padding: 40px;
						border-radius: 12px;
						box-shadow: 0 4px 20px rgba(0,0,0,0.1);
					}
					h1 { 
						color: #333; 
						text-align: center;
						margin-bottom: 30px;
					}
					.status { 
						background: #f8f9fa; 
						padding: 20px; 
						border-radius: 8px; 
						margin: 20px 0; 
						border-left: 4px solid #007bff;
					}
					.metric { 
						margin: 10px 0; 
						font-size: 16px;
					}
					.btn { 
						display: inline-block; 
						padding: 12px 24px; 
						background: #007bff; 
						color: white; 
						text-decoration: none; 
						border-radius: 6px; 
						margin: 10px 5px;
						font-weight: 500;
					}
					.btn:hover {
						background: #0056b3;
					}
				</style>
			</head>
			<body>
				<div class="container">
					<h1>🎵 Conference Server</h1>
					
					<div class="status">
						<h3>📊 Server Status</h3>
						<div class="metric">🟢 Server Online</div>
						<div class="metric">👥 Connected Users: ${totalUsers}</div>
						<div class="metric">📋 Queue Length: ${queueLength}</div>
						<div class="metric">🎤 Active Sessions: ${activeSessions}</div>
						<div class="metric">👨‍💼 Active Admins: ${activeAdmins}</div>
					</div>
					
					<div style="text-align: center; margin-top: 30px;">
						<a href="/admin" class="btn">🎧 Open Admin Panel</a>
					</div>
				</div>
			</body>
		</html>
	`);
});

// Health check
app.get("/health", (req, res) => {
	res.json({
		status: "ok",
		timestamp: Date.now(),
		users: state.users.size,
		admins: state.admins.size,
		queue: state.queue.length,
		activeSpeaker: state.activeSpeaker ? state.activeSpeaker.name : null,
		streamingSessions: state.streamingSessions.size,
	});
});

// Start server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
	console.log(`🚀 Conference Server running on http://${HOST}:${PORT}`);
	console.log(`👨‍💼 Admin panel: http://${HOST}:${PORT}/admin`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
	server.close(() => {
		process.exit(0);
	});
});

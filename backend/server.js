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
	queue: [], // Users waiting to speak
	activeSpeaker: null, // Current speaker
	admins: new Map(), // Connected admins
	users: new Map(), // Connected users
	speakerTimeout: null, // Timeout for active speaker
	streamingSessions: new Map(), // Audio streaming sessions
	settings: {
		maxQueueSize: 50,
		maxSpeakingTime: 180000, // 3 minutes
		autoDisconnectTime: 300000, // 5 minutes
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
		activeSpeaker: state.activeSpeaker
			? {
					name: state.activeSpeaker.name,
					startTime: state.activeSpeaker.startTime,
			  }
			: null,
		connectedUsers: state.users.size,
		connectedAdmins: state.admins.size,
		streamingSessions: state.streamingSessions.size,
	});
});

// Socket.io connection handling
io.on("connection", (socket) => {
	console.log(`New connection: ${socket.id}`);

	// Admin authentication
	socket.on("admin:auth", (data) => {
		console.log("Admin auth attempt from:", socket.id);
		const { password } = data;
		const adminPassword = process.env.ADMIN_PASSWORD || "admin123";

		if (password === adminPassword) {
			state.admins.set(socket.id, {
				id: socket.id,
				connectedAt: Date.now(),
			});
			socket.join("admins");
			socket.emit("admin:authenticated");
			sendStateUpdate();
			console.log(`👨‍💼 Admin authenticated: ${socket.id}`);
		} else {
			console.log(`Admin auth failed for: ${socket.id}`);
			socket.emit("admin:auth:failed");
		}
	});

	// Admin connection (from web panel)
	socket.on("admin:connect", () => {
		console.log(`👨‍💼 Admin connected: ${socket.id}`);
		state.admins.set(socket.id, {
			id: socket.id,
			connectedAt: Date.now(),
		});
		socket.join("admins");
		socket.emit("admin:connected", { message: "Admin panel connected" });
		sendStateUpdate();
	});

	// User joins conference
	socket.on("user:join", (data) => {
		const { name, deviceId } = data;

		console.log(`📱 User join request: ${name} from ${socket.id}`);

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

		console.log(
			`User joined: ${name} (${socket.id}). Total users: ${state.users.size}`
		);
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
		console.log(
			`📋 User queued: ${user.name} (position ${state.queue.length})`
		);
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
		console.log(`🎤 User now speaking: ${user.name}`);
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
			console.log(`❌ User request rejected: ${user?.name}`);
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

	// Audio streaming started (from mobile when user starts speaking)
	socket.on("streaming:start", (data) => {
		const user = state.users.get(socket.id);
		if (!user || !user.isSpeaking) {
			socket.emit("error", { message: "Not authorized to stream audio" });
			return;
		}

		console.log(`🎤 AUDIO STREAMING STARTED from ${user.name} (${socket.id})`);
		console.log(`📊 Format: ${data.format}, MIME: ${data.mimeType}`);

		state.streamingSessions.set(socket.id, {
			userId: socket.id,
			userName: user.name,
			startTime: Date.now(),
			totalChunks: 0,
			totalBytes: 0,
			format: data.format,
			mimeType: data.mimeType,
		});

		// Broadcast to all admins that live audio streaming started
		io.to("admins").emit("streaming:start", {
			...data,
			userId: socket.id,
			userName: user.name,
		});
	});

	// Audio chunk received (live streaming from mobile)
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

			const chunkSizeKB = data.size ? (data.size / 1024).toFixed(1) : "0";
			const elapsedTime = ((Date.now() - session.startTime) / 1000).toFixed(1);

			console.log(
				`🎵 LIVE AUDIO CHUNK #${data.chunkNumber} from ${user.name}:`
			);
			console.log(`   📏 Size: ${chunkSizeKB}KB`);
			console.log(`   🎚️ Format: ${data.format}`);
			console.log(`   ⏱️ Elapsed: ${elapsedTime}s`);
			console.log(`   📊 Total chunks: ${session.totalChunks}`);
			console.log(`   👨‍💼 Broadcasting to ${state.admins.size} admin(s)`);

			// Send acknowledgment to mobile app
			socket.emit("audio:chunk:ack", {
				chunkNumber: data.chunkNumber,
				received: true,
				timestamp: Date.now(),
			});

			// 🔊 BROADCAST LIVE AUDIO TO ALL ADMIN PANELS
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

			console.log(`🛑 AUDIO STREAMING ENDED from ${user?.name || socket.id}`);
			console.log(`📊 Session Summary:`);
			console.log(`   ⏱️ Duration: ${duration} seconds`);
			console.log(`   📦 Total chunks: ${session.totalChunks}`);
			console.log(`   📏 Total data: ${totalMB}MB`);
			console.log(`   🎚️ Format: ${session.format}`);

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

	// Test ping (for connection testing)
	socket.on("test:ping", (data) => {
		console.log(`📡 Test ping received from ${socket.id}:`, data.message);
		socket.emit("test:pong", { message: "Server received your ping!" });
	});

	// Disconnect handling
	socket.on("disconnect", () => {
		console.log(`Disconnected: ${socket.id}`);

		// Remove from admins
		if (state.admins.has(socket.id)) {
			state.admins.delete(socket.id);
			console.log(`👨‍💼 Admin disconnected: ${socket.id}`);
		}

		// Remove from users
		if (state.users.has(socket.id)) {
			const user = state.users.get(socket.id);

			// Remove from queue
			const queueIndex = state.queue.indexOf(socket.id);
			if (queueIndex !== -1) {
				state.queue.splice(queueIndex, 1);
				console.log(`📋 Removed ${user.name} from queue`);
			}

			// End if speaking
			if (state.activeSpeaker && state.activeSpeaker.userId === socket.id) {
				console.log(`🎤 Active speaker ${user.name} disconnected`);
				endActiveSpeaker();
			}

			// Clean up streaming session
			if (state.streamingSessions.has(socket.id)) {
				console.log(`🛑 Cleaning up streaming session for ${user.name}`);

				// Notify admins that streaming ended unexpectedly
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
			console.log(`📱 User disconnected: ${user.name}`);
		}

		sendStateUpdate();
	});
});

// Helper functions
function endActiveSpeaker() {
	if (!state.activeSpeaker) return;

	const { userId } = state.activeSpeaker;
	const user = state.users.get(userId);

	console.log(`🛑 Ending active speaker: ${user?.name || userId}`);

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
		console.log(`🛑 Ending streaming session for ${user?.name || userId}`);

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
	console.log("✅ Active speaker session ended");
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
		console.error("Error sending state update:", error);
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
				<title>Live Audio Conference Server</title>
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
				<h1>🎵 Live Audio Conference Server</h1>
				
				<div class="status">
					<h2>📊 Server Status</h2>
					<div class="metric">🟢 Server is running</div>
					<div class="metric">📱 Connected users: ${totalUsers}</div>
					<div class="metric">👨‍💼 Connected admins: ${activeAdmins}</div>
					<div class="metric">📋 Users in queue: ${queueLength}</div>
					<div class="metric">🎤 Active streaming sessions: ${activeSessions}</div>
					<div class="metric">⏰ Server time: ${new Date().toLocaleString()}</div>
				</div>
				
				<div class="status live">
					<h2>🔴 Conference Admin Panel</h2>
					<p>Manage speakers and listen to live audio:</p>
					<a href="/admin" class="btn">🎧 Open Conference Admin Panel</a>
				</div>
				
				<div class="status">
					<h2>🔧 How the Conference Works</h2>
					<ol>
						<li><strong>Users Connect:</strong> Mobile users join with their name</li>
						<li><strong>Request to Speak:</strong> Users request permission to speak</li>
						<li><strong>Admin Control:</strong> Admins approve/reject speaking requests</li>
						<li><strong>Live Audio:</strong> Approved users stream live audio to admins</li>
						<li><strong>Queue Management:</strong> Multiple users can queue up to speak</li>
						<li><strong>Real-time Control:</strong> Admins can end speaking sessions anytime</li>
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
	console.log(
		`🚀 Live Audio Conference Server running at http://${HOST}:${PORT}`
	);
	console.log(`🌐 Web interface: http://${HOST}:${PORT}`);
	console.log(`👨‍💼 Admin panel: http://${HOST}:${PORT}/admin`);
	console.log(`❤️  Health check: http://${HOST}:${PORT}/health`);
	console.log(`📡 Waiting for users and admins to connect...`);
});

// Error handling
process.on("uncaughtException", (error) => {
	console.error("Uncaught Exception:", error);
	if (process.env.NODE_ENV !== "production") {
		process.exit(1);
	}
});

process.on("unhandledRejection", (reason, promise) => {
	console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Graceful shutdown
process.on("SIGTERM", () => {
	console.log("SIGTERM received, shutting down gracefully...");
	server.close(() => {
		console.log("Server closed");
		process.exit(0);
	});
});

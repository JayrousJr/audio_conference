const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
	cors: {
		origin: "*",
		methods: ["GET", "POST"],
		credentials: true,
	},
	transports: ["websocket", "polling"],
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Debug logging
const DEBUG = true;
const log = (message, data = null) => {
	if (DEBUG) {
		console.log(`[${new Date().toISOString()}] ${message}`);
		if (data) console.log(JSON.stringify(data, null, 2));
	}
};

// In-memory storage
const state = {
	queue: [],
	activeSpeaker: null,
	admins: new Map(),
	users: new Map(),
	speakerTimeout: null,
	audioStats: {
		chunksReceived: 0,
		totalBytes: 0,
		lastChunkTime: null,
	},
	settings: {
		maxQueueSize: 50,
		maxSpeakingTime: 180000,
		autoDisconnectTime: 300000,
	},
};

// Serve admin panel
app.get("/admin", (req, res) => {
	res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Debug endpoint
app.get("/api/debug", (req, res) => {
	res.json({
		users: Array.from(state.users.entries()).map(([id, user]) => ({
			id,
			name: user.name,
			isSpeaking: user.isSpeaking,
			isInQueue: user.isInQueue,
		})),
		admins: state.admins.size,
		activeSpeaker: state.activeSpeaker,
		audioStats: state.audioStats,
		queue: state.queue,
	});
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
		audioStats: state.audioStats,
	});
});

// Socket.io connection handling
io.on("connection", (socket) => {
	log(`New connection: ${socket.id}`);

	// Admin authentication
	socket.on("admin:auth", (data) => {
		const { password } = data;
		if (password === process.env.ADMIN_PASSWORD || "admin123") {
			state.admins.set(socket.id, {
				id: socket.id,
				connectedAt: Date.now(),
			});
			socket.join("admins");
			socket.emit("admin:authenticated");
			sendStateUpdate();
			log(`Admin authenticated: ${socket.id}`);
		} else {
			socket.emit("admin:auth:failed");
		}
	});

	// User joins
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
		log(`User joined: ${name} (${socket.id})`);
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
		log(`User queued: ${user.name}`);
	});

	// Admin accepts user
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

		// Reset audio stats
		state.audioStats = {
			chunksReceived: 0,
			totalBytes: 0,
			lastChunkTime: null,
		};

		io.to(userId).emit("user:speaking:start");
		io.to("admins").emit("speaker:started", state.activeSpeaker);

		state.speakerTimeout = setTimeout(() => {
			endActiveSpeaker();
		}, state.settings.maxSpeakingTime);

		sendStateUpdate();
		log(`User speaking: ${user.name}`);
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

	// Audio chunk handling
	socket.on("audio:chunk", (data) => {
		const user = state.users.get(socket.id);

		log(`Audio chunk received from ${user?.name || "Unknown"}`, {
			userId: socket.id,
			dataSize: data.audio ? data.audio.length : 0,
			hasAudio: !!data.audio,
			isSpeaking: user?.isSpeaking,
		});

		if (!user || !user.isSpeaking) {
			socket.emit("error", { message: "Not authorized to send audio" });
			return;
		}

		// Update stats
		state.audioStats.chunksReceived++;
		state.audioStats.totalBytes += data.audio ? data.audio.length : 0;
		state.audioStats.lastChunkTime = Date.now();

		// Broadcast audio to all admins
		io.to("admins").emit("audio:stream", {
			userId: socket.id,
			userName: user.name,
			audio: data.audio,
			timestamp: Date.now(),
			chunkNumber: state.audioStats.chunksReceived,
		});

		// Send acknowledgment
		socket.emit("audio:chunk:ack", {
			received: true,
			chunkNumber: state.audioStats.chunksReceived,
		});
	});

	// User ends speaking
	socket.on("user:speaking:end", () => {
		if (state.activeSpeaker && state.activeSpeaker.userId === socket.id) {
			endActiveSpeaker();
		}
	});

	// Disconnect handling
	socket.on("disconnect", () => {
		log(`Disconnected: ${socket.id}`);

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

			state.users.delete(socket.id);
		}

		sendStateUpdate();
	});
});

// Helper functions
function endActiveSpeaker() {
	if (!state.activeSpeaker) return;

	const { userId } = state.activeSpeaker;

	if (state.speakerTimeout) {
		clearTimeout(state.speakerTimeout);
		state.speakerTimeout = null;
	}

	const user = state.users.get(userId);
	if (user) {
		user.isSpeaking = false;
		io.to(userId).emit("user:speaking:end");
	}

	log(`Speaker ended: ${state.activeSpeaker.name}`, {
		audioStats: state.audioStats,
	});

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
						  }
						: null;
				})
				.filter(Boolean),
			activeSpeaker: state.activeSpeaker
				? {
						userId: state.activeSpeaker.userId,
						name: state.activeSpeaker.name,
						startTime: state.activeSpeaker.startTime,
				  }
				: null,
			stats: {
				totalUsers: state.users.size,
				totalAdmins: state.admins.size,
				queueLength: state.queue.length,
				audioStats: state.audioStats,
			},
		};

		io.to("admins").emit("state:update", stateUpdate);
	} catch (error) {
		console.error("Error sending state update:", error);
	}
}

// Health check
app.get("/health", (req, res) => {
	res.json({
		status: "ok",
		timestamp: Date.now(),
		audioStats: state.audioStats,
	});
});

// Start server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
	console.log(`🚀 Debug Server running at http://${HOST}:${PORT}`);
	console.log(`📊 Admin panel: http://${HOST}:${PORT}/admin`);
	console.log(`🔍 Debug endpoint: http://${HOST}:${PORT}/api/debug`);
});

// Error handling
process.on("uncaughtException", (error) => {
	console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
	console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

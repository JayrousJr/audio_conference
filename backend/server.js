const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
	cors: {
		origin:
			process.env.NODE_ENV === "production"
				? ["http://145.223.98.156:3000", "http://145.223.98.156:3001"]
				: [
						"http://localhost:3000",
						"http://localhost:3001",
						"http://localhost:19000",
				  ],
		methods: ["GET", "POST"],
		credentials: true,
	},
	transports: ["websocket", "polling"],
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// In-memory storage (use Redis in production)
const state = {
	queue: [], // Users waiting to speak
	activeSpeaker: null, // Current speaker
	admins: new Map(), // Connected admins
	users: new Map(), // Connected users
	speakerTimeout: null, // Timeout for active speaker (stored separately)
	settings: {
		maxQueueSize: 50,
		maxSpeakingTime: 180000, // 3 minutes
		autoDisconnectTime: 300000, // 5 minutes
	},
};

// Serve admin panel
app.get("/admin", (req, res) => {
	res.sendFile(path.join(__dirname, "public", "admin.html"));
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
			console.log(`Admin authenticated: ${socket.id}`);
		} else {
			console.log(`Admin auth failed for: ${socket.id}`);
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
		console.log(`User joined: ${name} (${socket.id})`);
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
		console.log(`User queued: ${user.name}`);
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

		io.to(userId).emit("user:speaking:start");
		io.to("admins").emit("speaker:started", state.activeSpeaker);

		// Store timeout separately (not in state object to avoid circular reference)
		state.speakerTimeout = setTimeout(() => {
			endActiveSpeaker();
		}, state.settings.maxSpeakingTime);

		sendStateUpdate();
		console.log(`User speaking: ${user.name}`);
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

	// Audio chunk handling (fallback for non-WebRTC)
	socket.on("audio:chunk", (data) => {
		const user = state.users.get(socket.id);
		if (!user || !user.isSpeaking) {
			socket.emit("error", { message: "Not authorized to send audio" });
			return;
		}

		// Broadcast audio to all admins
		io.to("admins").emit("audio:stream", {
			userId: socket.id,
			userName: user.name,
			audio: data.audio,
			timestamp: Date.now(),
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
		console.log(`Disconnected: ${socket.id}`);

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

	// Clear timeout if exists
	if (state.speakerTimeout) {
		clearTimeout(state.speakerTimeout);
		state.speakerTimeout = null;
	}

	const user = state.users.get(userId);
	if (user) {
		user.isSpeaking = false;
		io.to(userId).emit("user:speaking:end");
	}

	io.to("admins").emit("speaker:ended", state.activeSpeaker);
	state.activeSpeaker = null;

	sendStateUpdate();
	console.log("Active speaker ended");
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
			},
		};

		io.to("admins").emit("state:update", stateUpdate);
	} catch (error) {
		console.error("Error sending state update:", error);
	}
}

// Health check
app.get("/health", (req, res) => {
	res.json({ status: "ok", timestamp: Date.now() });
});

// Start server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
	console.log(`🚀 Server running at http://${HOST}:${PORT}`);
	console.log(`📊 Admin panel: http://${HOST}:${PORT}/admin`);
});

// Error handling
process.on("uncaughtException", (error) => {
	console.error("Uncaught Exception:", error);
	// Log error but don't exit in production
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

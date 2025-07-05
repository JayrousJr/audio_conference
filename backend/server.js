const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const path = require("path");
const dotenv = require("dotenv");
const fs = require("fs");
const crypto = require("crypto");

dotenv.config();

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

		console.log(`User join request: ${name} from ${socket.id}`);

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

		// Send immediate update to all admins
		sendStateUpdate();

		// Also emit a specific user joined event
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

	// UPDATED: Enhanced audio chunk handling for expo-audio
	socket.on("audio:chunk", (data) => {
		const user = state.users.get(socket.id);
		if (!user || !user.isSpeaking) {
			socket.emit("error", { message: "Not authorized to send audio" });
			return;
		}

		const { audio, chunkNumber, format, mimeType, extension, size, timestamp } =
			data;

		// Enhanced logging with detailed format info
		console.log(`📡 Audio chunk received from ${user.name}:`, {
			chunkNumber,
			format,
			mimeType,
			extension,
			size: size || (audio ? audio.length : 0),
			timestamp: new Date(timestamp).toISOString(),
		});

		// Validate audio data
		if (!audio || audio.length === 0) {
			console.error(`❌ Empty audio data in chunk ${chunkNumber}`);
			return;
		}

		// Create enhanced chunk data for admin panel
		const enhancedChunkData = {
			userId: socket.id,
			userName: user.name,
			audio: audio,
			chunkNumber: chunkNumber,
			format: format || "unknown",
			mimeType: mimeType || getDefaultMimeType(format),
			extension: extension,
			size: size,
			timestamp: timestamp || Date.now(),
			receivedAt: Date.now(),
		};

		// Log successful receipt
		console.log(
			`✅ Broadcasting chunk ${chunkNumber} (${format}) to ${state.admins.size} admins`
		);

		// Broadcast to all admins with enhanced metadata
		io.to("admins").emit("audio:stream", enhancedChunkData);

		// Send acknowledgment back to client
		socket.emit("audio:chunk:ack", {
			chunkNumber: chunkNumber,
			received: true,
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

// Helper function to get default MIME type based on format
function getDefaultMimeType(format) {
	const mimeTypes = {
		m4a: "audio/mp4",
		mp4: "audio/mp4",
		wav: "audio/wav",
		webm: "audio/webm",
		caf: "audio/x-caf",
		aac: "audio/aac",
		mp3: "audio/mpeg",
		ogg: "audio/ogg",
	};
	return mimeTypes[format] || "audio/mp4";
}

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
			// Include connected users data for the admin panel
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

// Health check
app.get("/health", (req, res) => {
	res.json({ status: "ok", timestamp: Date.now() });
});

// Audio format info endpoint
app.get("/api/audio/formats", (req, res) => {
	res.json({
		supportedFormats: [
			{
				format: "m4a",
				mimeType: "audio/mp4",
				description: "MPEG-4 Audio (AAC)",
				compatibility: "Excellent web support",
				recommended: true,
			},
			{
				format: "wav",
				mimeType: "audio/wav",
				description: "Waveform Audio File",
				compatibility: "Universal support",
				recommended: true,
			},
			{
				format: "webm",
				mimeType: "audio/webm",
				description: "WebM Audio",
				compatibility: "Modern browsers",
				recommended: true,
			},
			{
				format: "caf",
				mimeType: "audio/x-caf",
				description: "Core Audio Format (iOS)",
				compatibility: "Limited to Apple devices",
				recommended: false,
			},
		],
		defaultFormat: "m4a",
		notes:
			"expo-audio HIGH_QUALITY preset typically produces M4A/AAC format with excellent web compatibility",
	});
});

// Start server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
	console.log(`🚀 Server running at http://${HOST}:${PORT}`);
	console.log(`📊 Admin panel: http://${HOST}:${PORT}/admin`);
	console.log(`🎵 Audio formats: http://${HOST}:${PORT}/api/audio/formats`);
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
